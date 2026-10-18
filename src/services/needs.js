/**
 * Sources Athena can ask for in the middle of a reply.
 *
 * The reply is one schema-constrained call written from context gathered up
 * front by guesses (keyword gates, Jev). When the guess misses, she used to
 * answer from nothing: on 2026-10-10 "what's the weather looking like for the
 * games today?" read no calendar, sent the raw sentence to Google, and was
 * answered about a Cleveland playoff game while the person's own soccer games
 * sat on their calendar.
 *
 * Now the reply schema has a `needs` field. A draft that fills it is not sent:
 * the code reads what she asked for and the reply is written again with the
 * results added. Rounds are capped (gemini.js), so "the games" can become
 * calendar → the 5:30 game at Clague Park → weather there at 5:30.
 *
 * Why a schema field and not function calling: replies run local-first, and
 * only the cloud Gemini path does native tool calls. A field works on every
 * tier that can produce the schema.
 *
 * Everything here only READS. The list of sources is fixed in code, each one
 * is offered only when the person has connected it (and, for live heart rate,
 * switched it on), and adults only — a child's words do not go to another
 * provider. A need is model output, so every field is treated as untrusted:
 * ranges are an enum, places are looked up rather than believed, and a web
 * query is screened before it leaves (see mayLeave).
 */
const llm = require("./llm");
const jev = require("./llm/adapters/jev");
const connectorContext = require("./connectors/context");
const heartRate = require("./heartRate");
const webSearch = require("./webSearch");
const weather = require("./weather");
const travel = require("./travel");
const family = require("./family");

const { RANGES, MAX_DATED_DAYS, NEEDS_SCHEMA, SOURCE_IDS } = require("./needsSchema");

/** The most needs read in one round; anything past it is dropped. */
const MAX_PER_ROUND = 3;

/**
 * Every source she can ask for. `provider` gates on a linked connector;
 * `heart` on the band's own opt-in; the rest are open to any adult.
 */
const SOURCES = [
	{
		id: "calendar",
		provider: "google_calendar",
		doc: '`{ "source": "calendar", "range": "today" | "tomorrow" | "this_week" | "next_30_days" }` — their own calendar. Ask when they mention "the game", "practice", "tonight", "my meeting" or anything that could be on it. For anything further out — a trip next summer, "what\'s happening in March" — give dates instead of a range: `{ "source": "calendar", "from": "2027-06-01", "to": "2027-07-15" }` (YYYY-MM-DD, up to three years ahead, at most 60 days per lookup; ask for several to cover a longer stretch).',
	},
	{
		id: "email",
		provider: "gmail",
		doc: '`{ "source": "email" }` — their recent inbox.',
	},
	{
		id: "whoop",
		provider: "whoop",
		doc: '`{ "source": "whoop" }` — sleep, recovery, strain and workouts from WHOOP.',
	},
	{
		id: "heart_rate",
		heart: true,
		doc: '`{ "source": "heart_rate" }` — their live heart rate from the band.',
	},
	{
		id: "weather",
		doc: '`{ "source": "weather", "place": "Clague Park, Westlake OH" | "home", "when": "2026-10-10T17:30:00-04:00" }` — the forecast at a place and time, up to a week out. Take `place` and `when` from their calendar event when the question is about one; "home" is their home. Never search the web for weather.',
	},
	{
		id: "groceries",
		provider: "google_keep",
		doc: '`{ "source": "groceries" }` — their shared grocery list: what they still need, and what they ticked off lately (probably at home). Ask before suggesting what to cook or eat, so ideas start from what they have.',
	},
	{
		id: "web",
		web: true,
		doc: '`{ "source": "web", "query": "..." }` — a Google search you write. Write it the way a person would type it, specific to what they mean ("Westlake OH high school football score Friday", not "the game"). It may name places, times, businesses and public figures; NEVER a family member\'s or private person\'s name, anything about health, or anything from their email or messages — those stay here.',
	},
];

const BY_ID = new Map(SOURCES.map((s) => [s.id, s]));
if (SOURCES.some((s) => !SOURCE_IDS.includes(s.id)) || SOURCE_IDS.length !== SOURCES.length) {
	throw new Error("needs: SOURCES and needsSchema.SOURCE_IDS disagree");
}

/** The source ids this person can be read from right now. Adults only; never throws. */
async function available(profileId, { audience } = {}) {
	if (!profileId || audience !== "adult") return [];
	const [linked, heartOn] = await Promise.all([
		connectorContext.linkedProviders(profileId).catch(() => new Set()),
		heartRate
			.getPref(profileId)
			.then((p) => !!p?.enabled)
			.catch(() => false),
	]);
	return SOURCES.filter((s) => (s.provider ? linked.has(s.provider) : s.heart ? heartOn : true)).map((s) => s.id);
}

/** The prompt block that tells her `needs` exists. Null when nothing is available. */
function promptBlock(ids, { final = false } = {}) {
	if (!ids || !ids.length) return null;
	if (final) {
		return [
			"# No more lookups this turn",
			"You've already looked up what you could. Answer now with what's above, and leave `needs` empty.",
			"Where something you wanted isn't there, say plainly what you couldn't get rather than guessing.",
		].join("\n");
	}
	return [
		"# Looking things up before you answer",
		"If answering well depends on something that is NOT already above, don't guess and don't answer about",
		"something else: put what you need in `needs` and set `response` to a few words like \"Let me check.\"",
		"That reply isn't sent — what you asked for is read and you write the reply again with it.",
		"Leave `needs` empty (or omit it) whenever you can answer from what you have, which is most of the time.",
		"",
		"Their own world comes before the web: if \"the game\" or \"tonight\" could be on their calendar, check the",
		"calendar first, and only search the web once you know what they mean.",
		"",
		"You can ask for:",
		...ids.map((id) => `- ${BY_ID.get(id).doc}`),
	].join("\n");
}

/** Model-written needs, cleaned: known, available, unread, at most MAX_PER_ROUND. */
function clean(raw, ids, done = new Set()) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (const need of raw) {
		if (!need || typeof need !== "object" || !ids.includes(need.source)) continue;
		const n = { source: need.source };
		if (need.source === "calendar") {
			const from = isoDay(need.from);
			if (from) {
				const to = isoDay(need.to);
				n.from = from;
				n.days = to && to >= from ? Math.min((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1, MAX_DATED_DAYS) : 30;
			} else {
				n.range = RANGES[need.range] ? need.range : "this_week";
			}
		}
		if (need.source === "weather") {
			n.place = typeof need.place === "string" && need.place.trim() ? need.place.trim().slice(0, 200) : "home";
			n.when = typeof need.when === "string" ? need.when.trim().slice(0, 40) : null;
		}
		if (need.source === "web") {
			n.query = typeof need.query === "string" ? need.query.trim().slice(0, 300) : "";
			if (!n.query) continue;
		}
		const key = keyOf(n);
		if (done.has(key) || out.some((o) => keyOf(o) === key)) continue;
		out.push(n);
		if (out.length >= MAX_PER_ROUND) break;
	}
	return out;
}

function keyOf(n) {
	return [n.source, n.range, n.from, n.days, n.place, n.when, n.query].filter(Boolean).join("|").toLowerCase();
}

/** A real "YYYY-MM-DD", or null. How far out it may be is the calendar's call. */
function isoDay(value) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
	const day = value.trim();
	const at = new Date(`${day}T00:00:00Z`);
	return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === day ? day : null;
}

const HOME = /^(home|my house|our house|the house|at home)$/i;

/** "Sat 11 Oct, 5:30 pm" in their zone. */
function hourLabel(iso, timeZone) {
	try {
		return new Intl.DateTimeFormat("en-US", {
			weekday: "short",
			hour: "numeric",
			minute: "2-digit",
			...(timeZone ? { timeZone } : {}),
		}).format(new Date(iso));
	} catch {
		return iso;
	}
}

async function weatherBlock(profileId, need, { timeZone }) {
	const header = "# Weather (you looked this up just now, from the US National Weather Service)";
	const point = HOME.test(need.place) ? await travel.homeOf(profileId) : await travel.locate(profileId, need.place);
	if (!point) {
		return `${header}\n\nCouldn't find "${need.place}" on the map${HOME.test(need.place) ? " (no home saved on the Community page)" : ""}. Say you couldn't look up the weather there; don't guess it.`;
	}
	const when = need.when && Number.isFinite(new Date(need.when).getTime()) ? need.when : null;
	const sky = await weather.forecast(point.latitude, point.longitude, { hours: 4, from: when });
	const name = point.address ? `${point.name} (${point.address})` : point.name;
	if (!sky) {
		return `${header}\n\nNo forecast for ${name}${when ? ` at ${hourLabel(when, timeZone)}` : ""} — it may be more than a week out or outside US coverage. Say so; don't guess the weather.`;
	}
	return [
		header,
		`At ${name}${when ? `, from ${hourLabel(when, timeZone)}` : ", the next few hours"}:`,
		...sky.hours.map(
			(h) =>
				`- ${hourLabel(h.start, timeZone)}: ${h.temperatureF ?? "?"}°F, ${h.shortForecast || "no description"}` +
				`${h.precipitationChance != null ? `, ${h.precipitationChance}% chance of rain` : ""}` +
				`${h.windSpeed ? `, wind ${h.windSpeed}` : ""}`
		),
	].join("\n");
}

/**
 * May this model-written query leave for Google? The owner's rule
 * (2026-10-10): places, times, businesses and public names yes; a family
 * member's or private person's name, health, or email/message contents
 * never. Children's names are refused in code; the rest is Jev's call, and
 * without Jev the query does not go — her own query fails closed, and the
 * reply is told the search wasn't run.
 */
async function mayLeave(profileId, query) {
	try {
		const fam = await family.getFamilyForProfile(profileId).catch(() => null);
		const children = fam ? await family.listChildren(fam.id).catch(() => []) : [];
		const lower = query.toLowerCase();
		for (const c of children) {
			const first = String(c.display_name || "").trim().split(/\s+/)[0];
			if (first && first.length > 1 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)) {
				return false;
			}
		}
		if (!(await jev.configured())) return false;
		const out = await llm.decide({
			task: "screen",
			state: `A web search query about to be sent to Google: ${query}`,
			questions: {
				private: {
					type: "noul",
					instructions:
						"Does this query contain the name of a private individual (not a public figure, business, team or place), " +
						"anything about someone's health, or what looks like the content of a private email or message?",
					criteria: { true: "Yes — something private", false: "No — places, times, public names and general topics only" },
				},
			},
			timeoutMs: 800,
		});
		const p = Number(out?.answers?.private?.noul);
		return Number.isFinite(p) && p < 0.5;
	} catch (err) {
		console.warn("[needs] query screen failed:", err.message);
		return false;
	}
}

/**
 * Read what she asked for. Returns { blocks: [string], sources: [web links],
 * read: [keys] }; never throws — a failed read is a block saying so, so she
 * says she couldn't get it rather than guessing.
 */
async function fetch(profileId, needs, { audience, timeZone, onRead } = {}) {
	if (!profileId || audience !== "adult" || !needs.length) return { blocks: [], sources: [], read: [] };
	const results = await Promise.all(
		needs.map(async (need) => {
			try {
				switch (need.source) {
					case "calendar":
						return {
							block: await connectorContext.buildContext(profileId, {
								message: "",
								providers: ["google_calendar"],
								daysByProvider: { google_calendar: need.from ? need.days : RANGES[need.range] },
								...(need.from ? { fromByProvider: { google_calendar: need.from } } : {}),
								audience,
								onRead,
							}),
						};
					case "email":
					case "whoop":
					case "groceries":
						return {
							block: await connectorContext.buildContext(profileId, {
								message: "",
								providers: [BY_ID.get(need.source).provider],
								audience,
								onRead,
							}),
						};
					case "heart_rate":
						return { block: await heartRate.buildContext(profileId, { message: "", audience, force: true }) };
					case "weather":
						return { block: await weatherBlock(profileId, need, { timeZone }) };
					case "web": {
						if (!(await mayLeave(profileId, need.query))) {
							console.info("[needs] web query held back as private");
							return {
								block: `# Web search not run\nYour search "${need.query}" wasn't sent: it looked like it named a private person or carried something private. Answer from what you have, or search again without the private part.`,
							};
						}
						const web = await webSearch.buildContext(need.query, { audience });
						return web
							? { block: web.block, sources: web.sources }
							: { block: `# Web search\nNothing came back for "${need.query}". Say you couldn't find it; don't guess.` };
					}
					default:
						return null;
				}
			} catch (err) {
				console.warn(`[needs] ${need.source} failed:`, err.message);
				return { block: `# ${need.source}\nThat lookup failed just now. Say you couldn't get it; don't guess.` };
			}
		})
	);
	return {
		blocks: results.map((r) => r?.block).filter(Boolean),
		sources: results.flatMap((r) => r?.sources || []),
		read: needs.map(keyOf),
	};
}

module.exports = { SOURCES, RANGES, NEEDS_SCHEMA, MAX_PER_ROUND, available, promptBlock, clean, fetch, mayLeave, keyOf };
