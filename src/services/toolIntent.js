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
 *   SPEAK_AT  — high. Say "let me check your calendar, hmm…". A filler that
 *               announces a check she then doesn't use is a small lie, so it
 *               needs real confidence.
 *
 * Only sources the person has actually connected (and, for live heart rate,
 * switched on) are ever asked about, so she can never announce a check of
 * something she cannot see. Anything going wrong returns null and the caller
 * falls back to the keyword gates — the guess is an accelerator, never a gate.
 *
 * The filler lines are a fixed set built from fixed fragments, one per
 * combination, so they can be pre-recorded on the phone and played the moment
 * the guess lands. Never model-written.
 */
const llm = require("./llm");
const connectorContext = require("./connectors/context");
const heartRate = require("./heartRate");

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
		say: "your calendar",
		question:
			"Would answering this need the person's calendar — their schedule, plans, " +
			"events, appointments, or whether they are free or busy at some time?",
	},
	{
		id: "email",
		provider: "gmail",
		say: "your email",
		question:
			"Would answering this need the person's email inbox — messages they received, " +
			"who wrote to them, or something that arrived by email?",
	},
	{
		id: "whoop",
		provider: "whoop",
		say: "WHOOP",
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
		id: "strava",
		provider: "strava",
		say: "Strava",
		question:
			"Would answering this need the person's Strava history — runs, rides, " +
			"workouts they logged, distances, pace or training volume?",
	},
	{
		id: "heart_rate",
		provider: null,
		say: null, // spoken as its own clause, see fillerLine
		question:
			"Would answering this need the person's live heart rate from their band — " +
			"what it is right now, or during today's activity?",
	},
];

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
	return SOURCES.filter((s) => (s.provider ? linked.has(s.provider) : heartOn));
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

/** "your calendar", "WHOOP and Strava", "your calendar, WHOOP and Strava". */
function joinNames(names) {
	if (names.length <= 1) return names[0] || "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The fixed filler for a set of announced sources. Deterministic, so every
 * combination can be recorded once and shipped as a clip; `key` names it.
 */
function fillerLine(ids) {
	const sorted = [...new Set(ids)].sort();
	if (!sorted.length) return null;
	const names = SOURCES.filter((s) => sorted.includes(s.id) && s.say).map((s) => s.say);
	const heart = sorted.includes("heart_rate");
	let text;
	if (!names.length) text = "Let me grab your heart rate, hmm…";
	else if (heart) text = `Let me check ${joinNames(names)}, and I'll grab your heart rate off the band too…`;
	else text = `Let me check ${joinNames(names)}, hmm…`;
	return { key: sorted.join("+"), text };
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
	const pool = sources || (profileId ? await availableSources(profileId, { audience }) : []);
	if (!pool.length) return null;

	let result;
	try {
		result = await llm.decide({
			task: "intent",
			state: message.trim().slice(0, 2000),
			questions: buildQuestions(pool),
			timeoutMs: TIMEOUT_MS,
		});
	} catch (err) {
		console.warn("[toolIntent] no guess:", err.message);
		return null;
	}

	const scores = {};
	const noul = (key) => {
		const p = Number(result.answers?.[key]?.noul);
		return Number.isFinite(p) ? p : 0;
	};
	for (const source of pool) {
		scores[source.id] = Math.max(noul(source.id), source.also ? noul(`${source.id}_also`) : 0);
	}
	const fetch = pool.map((s) => s.id).filter((id) => scores[id] >= FETCH_AT);
	const announce = fetch.filter((id) => scores[id] >= SPEAK_AT);
	const window = WINDOWS[result.answers?.window?.choice] ? result.answers.window.choice : "unspecified";

	return {
		fetch,
		announce,
		filler: fillerLine(announce),
		window,
		days: WINDOWS[window].days,
		scores,
		latencyMs: result.latencyMs,
		model: result.model,
	};
}

module.exports = {
	guess,
	availableSources,
	buildQuestions,
	fillerLine,
	SOURCES,
	WINDOWS,
	FETCH_AT,
	SPEAK_AT,
};
