/**
 * The fast guess: which of Athena's passive sources does this message need?
 *
 * The connectors' keyword gates miss ordinary speech — "anything going on
 * tonight?" names no calendar word — and when they miss she has nothing to
 * read and either guesses or promises to "check" in a reply that has no later.
 * This asks Jev (llm.decide, ~0.1–0.4 s) instead, one yes/no per source, all
 * in one parallel request, plus which stretch of time the question is about.
 *
 * Two thresholds, on purpose:
 *   FETCH_AT  — low. Start the read. Reads are cached and cheap, so a wrong
 *               guess costs one wasted fetch.
 *   SPEAK_AT  — high. Say "Let me check your calendar.". A filler that
 *               announces a check she then doesn't use is a small lie, so it
 *               needs real confidence.
 *
 * Only sources the person has actually connected (and, for live heart rate,
 * switched on) are ever asked about, so she can never announce a check of
 * something she cannot see. Anything going wrong returns null and the caller
 * falls back to the keyword gates — the guess is an accelerator, never a gate.
 *
 * The filler lines are a small fixed set (see fillerLine), so the phone can
 * cache each one the first time it hears it and play it the moment the guess
 * lands. Never model-written. The wording lives here, not on the phone: a new
 * line needs a server deploy, not an APK.
 */
const llm = require("./llm");
const jev = require("./llm/adapters/jev");
const connectorContext = require("./connectors/context");
const heartRate = require("./heartRate");
const webSearch = require("./webSearch");
const location = require("./location");
const whereabouts = require("./whereabouts");
const perfTrace = require("./perfTrace");

const FETCH_AT = 0.35;
const SPEAK_AT = 0.7;
// The whole point is to beat the reply to the punch; a slower guess is no guess.
const TIMEOUT_MS = 800;

/**
 * Every source Jev can be asked about. `provider` is the connector's
 * credential name; heart rate is the phone's Bluetooth band, gated by its own
 * opt-in instead.
 */
const SOURCES = [
	{
		id: "calendar",
		provider: "google_calendar",
		line: "Let me check your calendar.",
		question:
			"Would answering this need the person's calendar — their schedule, plans, " +
			"events, appointments, or whether they are free or busy at some time?",
	},
	{
		id: "email",
		provider: "gmail",
		line: "Let me check your email.",
		question:
			"Would answering this need the person's email inbox — messages they received, " +
			"who wrote to them, or something that arrived by email?",
	},
	{
		id: "whoop",
		provider: "whoop",
		line: "Let me check WHOOP.",
		question:
			"Would answering this need the person's WHOOP data — how they slept, how " +
			"recovered or rested their body is, strain, HRV or resting heart rate?",
		// Jev ties the brand to workouts more than to sleep ("how did I sleep?"
		// scored 0.5 on the question above), so sleep gets its own question and
		// the source takes whichever answer is higher.
		also:
			"Is the person asking about their own sleep — how long or how well they " +
			"slept, or how tired or rested they are?",
	},
	{
		id: "heart_rate",
		provider: null,
		line: "Let me grab your heart rate.",
		question:
			"Would answering this need the person's live heart rate from their band — " +
			"what it is right now, or during today's activity?",
	},
	{
		// Not a connector: every adult has it (services/webSearch). A search costs
		// real money and a few seconds, so it needs more confidence than a
		// connector read — see WEB_FETCH_AT.
		id: "web",
		provider: null,
		web: true,
		line: "Let me look that up.",
		question:
			"Would answering this well need a fresh web search — news, scores, prices, " +
			"weather, schedules, opening hours, releases, or any fact about the world " +
			"that may have changed recently or that a person would look up?",
	},
	{
		// Not a connector: the paired phone, only with location context switched
		// on (services/location). Reading it wakes the phone with a silent push
		// and spends a Places lookup, so like the web it needs more confidence
		// than a cached connector read — see LOCATION_FETCH_AT.
		id: "location",
		provider: null,
		location: true,
		line: "Let me check where your phone is.",
		question:
			"Would answering this need where the person or their phone is right now — " +
			"their current location, what place, town or road they're at, or what's near them?",
	},
	{
		// Not a read the guess starts: her long-term memories are recalled on
		// every adult turn anyway (memoryStore). Asked only so she can say she's
		// looking when the answer rests on what they told her before — the
		// owner's "Let me think back." when she needs to search memories. Never
		// in `fetch`; counts as a lookup in fillerLine only when Jev is sure.
		id: "memories",
		provider: null,
		memory: true,
		line: "Let me think back.",
		question:
			"Would answering this need something the person told Athena before — a past " +
			"conversation, a plan, a name, a preference or a detail she would have to remember?",
	},
];

// A wrong web guess spends a search; a wrong connector guess spends a cached read.
const WEB_FETCH_AT = 0.6;
// A wrong location guess wakes their phone for nothing.
const LOCATION_FETCH_AT = 0.6;

/** What stretch of time the question is about, and how many days to read. */
const WINDOWS = {
	now: { days: 1, means: "Right now or within the next hour or so" },
	later_today: { days: 1, means: "Later today, this afternoon, this evening or tonight" },
	tomorrow: { days: 2, means: "Tomorrow, tomorrow morning or tomorrow night" },
	this_week: { days: 7, means: "The next few days, this week or this weekend" },
	further: { days: 30, means: "Next week, next month or a specific later date" },
	unspecified: { days: 7, means: "No particular time, or not about the future at all" },
};

/** The sources this person can actually be read from right now. */
async function availableSources(profileId, { audience } = {}) {
	const linked = await connectorContext.linkedProviders(profileId).catch(() => new Set());
	const heartOn =
		audience === "adult"
			? await heartRate.getPref(profileId).then((p) => p.enabled).catch(() => false)
			: false;
	const locationOn =
		audience === "adult"
			? await location.getPref(profileId).then((p) => p.enabled).catch(() => false)
			: false;
	return SOURCES.filter((s) =>
		s.web || s.memory
			? audience === "adult"
			: s.location
				? locationOn
				: s.provider
					? linked.has(s.provider)
					: heartOn
	);
}

function buildQuestions(sources) {
	const questions = {};
	for (const source of sources) {
		questions[source.id] = {
			type: "noul",
			instructions: source.question,
			criteria: {
				true: "Yes — the answer depends on this data",
				false: "No — this data would not help answer it",
			},
		};
		if (source.also) {
			questions[`${source.id}_also`] = {
				type: "noul",
				instructions: source.also,
				criteria: { true: "Yes", false: "No" },
			};
		}
	}
	questions.window = {
		type: "choice",
		instructions: "Which stretch of time is the person asking about?",
		criteria: Object.fromEntries(Object.entries(WINDOWS).map(([k, w]) => [k, w.means])),
	};
	return questions;
}

/** Said when the turn waits on several lookups. */
const MOMENT = Object.freeze({ key: "moment", text: "Just a moment." });

/**
 * The spoken waiting line for a turn, from what Jev predicted (owner,
 * 2026-11-05: a line from the lookup, not from a timer):
 *
 *   - one lookup, and Jev is sure which → that source's own line
 *     ("Let me check your calendar.", "Let me look that up.")
 *   - several lookups, which will hold up the reply → "Just a moment."
 *   - nothing to look up, or one lookup Jev isn't sure of → null; the
 *     client's own timed "Hmm." covers the wait.
 *
 * `sure` are the sources at SPEAK_AT, `fetch` the reads that will actually
 * start. With one argument both are the same set. Deterministic fixed
 * strings, so the phone caches each one once; `key` names it.
 */
function fillerLine(sure, fetch = sure) {
	const byId = (id) => SOURCES.find((s) => s.id === id);
	const said = new Set((sure || []).filter(byId));
	// What will actually be waited on: the reads, plus a memory search she is
	// sure the answer rests on.
	const waits = [...new Set([...(fetch || []).filter(byId), ...said])];
	if (!waits.length) return null;
	if (waits.length > 1) return { ...MOMENT };
	const [only] = waits;
	return said.has(only) ? { key: only, text: byId(only).line } : null;
}

/**
 * Guess which sources `message` needs. Returns null when there is nothing to
 * guess about (no sources, Jev not configured) or the guess failed.
 *
 *   { fetch: ["calendar"], announce: ["calendar"], filler: { key, text },
 *     window: "later_today", days: 1, scores: { calendar: 0.93, … },
 *     latencyMs, model }
 */
async function guess(message, { profileId, audience, sources } = {}) {
	if (typeof message !== "string" || !message.trim()) return null;
	// No key on this deployment: skip quietly rather than failing (and logging)
	// on every message.
	if (!(await jev.configured())) return null;
	const endSources = perfTrace.begin("jev.sources");
	const pool = sources || (profileId ? await availableSources(profileId, { audience }) : []);
	endSources({ n: pool.length });
	if (!pool.length) return null;

	let result;
	const endDecide = perfTrace.begin("jev.decide", { questions: pool.length });
	try {
		result = await llm.decide({
			task: "intent",
			state: message.trim().slice(0, 2000),
			questions: buildQuestions(pool),
			timeoutMs: TIMEOUT_MS,
		});
	} catch (err) {
		endDecide({ failed: true, timeout: /timed out/i.test(err.message || "") });
		console.warn("[toolIntent] no guess:", err.message);
		return null;
	}
	endDecide({ jevMs: result.latencyMs ?? null });

	const scores = {};
	const noul = (key) => {
		const p = Number(result.answers?.[key]?.noul);
		return Number.isFinite(p) ? p : 0;
	};
	for (const source of pool) {
		scores[source.id] = Math.max(noul(source.id), source.also ? noul(`${source.id}_also`) : 0);
	}
	// Memories are recalled every turn regardless, so they are never a read
	// the guess starts — only something she can be sure the answer rests on.
	const fetch = pool
		.filter((s) => !s.memory)
		.filter((s) => scores[s.id] >= (s.web ? WEB_FETCH_AT : s.location ? LOCATION_FETCH_AT : FETCH_AT))
		.map((s) => s.id);
	const announce = pool
		.filter((s) => scores[s.id] >= SPEAK_AT && (s.memory || fetch.includes(s.id)))
		.map((s) => s.id);
	const window = WINDOWS[result.answers?.window?.choice] ? result.answers.window.choice : "unspecified";

	return {
		fetch,
		announce,
		filler: fillerLine(announce, fetch),
		window,
		days: WINDOWS[window].days,
		scores,
		latencyMs: result.latencyMs,
		model: result.model,
	};
}

/**
 * What the guess adds beyond the keyword gates, for the grounding step:
 *   { providers: ["google_calendar"], daysByProvider: { google_calendar: 1 },
 *     heartRate: false, web: false, location: false }
 * Sources a keyword gate already caught are left out — they are being fetched
 * already, and fetching them twice would put two copies in the prompt.
 * Returns null when there is nothing to add.
 */
function extraGrounding(guessed, message) {
	if (!guessed || !guessed.fetch.length) return null;
	const covered = new Set(connectorContext.relevantConnectors(message).map((c) => c.PROVIDER));
	const providers = SOURCES.filter(
		(s) => s.provider && guessed.fetch.includes(s.id) && !covered.has(s.provider)
	).map((s) => s.provider);
	const heart = guessed.fetch.includes("heart_rate") && !heartRate.matches(message);
	const web = guessed.fetch.includes("web") && !webSearch.matches(message);
	const here = guessed.fetch.includes("location") && !whereabouts.matches(message);
	if (!providers.length && !heart && !web && !here) return null;
	// Only the calendar is about the future; the guess's window means nothing
	// to WHOOP history, which keeps its own default.
	const daysByProvider = providers.includes("google_calendar")
		? { google_calendar: guessed.days }
		: {};
	return { providers, daysByProvider, heartRate: heart, web, location: here };
}

module.exports = {
	guess,
	extraGrounding,
	availableSources,
	buildQuestions,
	fillerLine,
	SOURCES,
	WINDOWS,
	FETCH_AT,
	SPEAK_AT,
	MOMENT,
};
