/**
 * Live conversation: talking with Athena over Gemini Live.
 *
 * The old conversation mode is a relay — words, then a reply written in one
 * strict-JSON call, then a second look, then speech — and every stage waits
 * for the one before. Here the browser streams the microphone straight to a
 * speech-to-speech model that hears, decides when you've finished, answers in
 * her voice (Aoede) and stops when you cut in. Measured target: under a second
 * from the end of your sentence to her first word.
 *
 * What stays on the server:
 * - **Who she is.** The system instruction, voice and tools are built here and
 *   locked into a one-use token (llm/adapters/gemini.liveToken). The page only
 *   ever holds that token, never the key, and can't change any of them.
 * - **Reading the person's world.** Her one tool, `look_up`, comes back here
 *   and goes through the same `needs` code as chat: only sources the person
 *   has connected, adults only, model output treated as untrusted, web
 *   queries screened before they leave.
 * - **The transcript.** Each finished turn is written to `message` like a chat
 *   turn, and memory extraction runs on it afterwards, so history, recall and
 *   the nightly review keep working.
 *
 * Nothing here can act in the world: there is no action tool yet. Actions
 * will come back as proposals through the action layer, never as a direct path.
 *
 * Adults only. A child's session gets the old conversation mode, which keeps
 * its own safety prompts.
 */
const gemini = require("../llm/adapters/gemini");
const needs = require("../needs");
const messageService = require("../message");
const memoryStore = require("../memoryStore");
const { getMemorySummaryForProfileId } = require("../memory");
const { audienceForSession, memoryEnabledForProfile } = require("../audience");
const { buildCapabilityBlock } = require("../selfKnowledge");
const { CORE_MISSION } = require("../../security/mission");
const actions = require("../actions");

const MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";
const VOICE = process.env.GEMINI_TTS_VOICE || "Aoede";
/** How much of this conversation's recent history she starts with. */
const HISTORY_TURNS = 20;
const MAX_TURN_CHARS = 4000;
const TOOL = "look_up";
const ACT = "act";
const END = "end_conversation";
const TOOLS = [TOOL, ACT, END];
/** Lookups per call. Chat keeps needs.MAX_PER_ROUND; a live call can take more at once. */
const MAX_LOOKUPS = 6;

/**
 * The look_up declaration, with the sources this person can be read from.
 * NON_BLOCKING: she keeps talking ("let me look…") while it runs, and the
 * result is given to her when she's finished her sentence (WHEN_IDLE).
 */
function lookUpTool(ids) {
	return {
		name: TOOL,
		behavior: "NON_BLOCKING",
		description:
			"Read something from the person's own world (their calendar, inbox, WHOOP, the weather somewhere, the web) before answering. " +
			"Use it whenever a good answer depends on something you haven't been told. Say a few words first, like \"let me check\", then call it.",
		parameters: {
			type: "OBJECT",
			properties: {
				needs: {
					type: "ARRAY",
					description: `What to read, all at once. Up to ${MAX_LOOKUPS} per call.`,
					items: {
						type: "OBJECT",
						properties: {
							source: { type: "STRING", enum: ids },
							range: { type: "STRING", description: "calendar: today, tomorrow, this_week or next_30_days" },
							from: { type: "STRING", description: "calendar: first day, YYYY-MM-DD" },
							to: { type: "STRING", description: "calendar: last day, YYYY-MM-DD" },
							place: { type: "STRING", description: "weather: a place, or \"home\"" },
							when: { type: "STRING", description: "weather: an ISO date-time" },
							query: { type: "STRING", description: "web: the search; sightings: a name or \"stranger\"" },
						},
						required: ["source"],
					},
				},
			},
			required: ["needs"],
		},
	};
}

/** The act declaration: do one of the actions this person has. */
function actTool(actionIds) {
	return {
		name: ACT,
		behavior: "NON_BLOCKING",
		description:
			"Do something for them that they just asked you to do out loud (add to the calendar, send, set, remind…). " +
			"Their asking is their approval, so this does it. Never call it for something they didn't ask for.",
		parameters: {
			type: "OBJECT",
			properties: {
				action: { type: "STRING", enum: actionIds },
				params_json: { type: "STRING", description: "The action's parameters as a JSON object, exactly as that action describes them." },
				request: { type: "STRING", description: "Their words asking for it, as they said them." },
			},
			required: ["action", "params_json", "request"],
		},
	};
}

function endTool() {
	return {
		name: END,
		description:
			"End the live conversation. Call it once the conversation is over: they've said goodbye, said that's all, or said to stop. Say your goodbye first.",
		parameters: { type: "OBJECT", properties: {} },
	};
}

function actionsBlock(available) {
	if (!available?.length) return null;
	const lines = [
		"# Doing things for them",
		`When they ask you to do something below, do it with ${ACT}: their asking out loud IS their approval. Don't ask "want me to…?" for something they just asked for.`,
		"Only do what they asked. If what they want is unclear — which day, which person — ask first, then do it once they've said.",
		"Say what you're doing as you do it (\"adding it now\"), then tell them it's done once the result comes back. If it fails, say so plainly.",
		"Something you'd suggest yourself that they haven't asked for: offer it, and do it only once they say yes.",
		"",
	];
	for (const a of available) {
		lines.push(`## ${a.id}`, a.describe, "Parameters:");
		for (const [name, description] of Object.entries(a.params || {})) lines.push(`- ${name}: ${description}`);
		lines.push("");
	}
	return lines.join("\n");
}

function nowLine(timeZone) {
	const zone = isZone(timeZone) ? timeZone : "America/New_York";
	const when = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date());
	return `It is ${when} (${zone}).`;
}

function isZone(value) {
	if (typeof value !== "string" || !value) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

function historyBlock(messages) {
	const recent = (messages || []).filter((m) => typeof m?.text === "string" && m.text.trim()).slice(-HISTORY_TURNS);
	if (!recent.length) return null;
	return [
		"# Earlier in this conversation",
		"(Most recent last. Pick up from here naturally; don't recap it.)",
		...recent.map((m) => `${Number(m.is_human) ? "Them" : "You"}: ${m.text.trim().slice(0, 600)}`),
	].join("\n");
}

function memoryBlock(memories) {
	if (!memories?.length) return "# What you know about them\nNothing saved yet.";
	return ["# What you know about them (durable facts)", ...memories.map((m) => `- (${m.category}) ${m.key}: ${m.value}`)].join("\n");
}

/** Her instructions for a spoken conversation. Exported for the tests. */
function systemText({ firstName, timeZone, memories, history, ids, capabilities, actions = null }) {
	return [
		CORE_MISSION,
		`You are Athena, a personal AI companion${firstName ? ` to ${firstName}` : ""}, an adult. You are talking with them OUT LOUD, in real time, in your own voice. ${nowLine(timeZone)}`,
		[
			"# How you talk",
			"- Warm, sharp, curious, and a little dry. You have opinions and share them. You notice things. You remember.",
			"- This is a spoken conversation. Say as much as the moment needs — a quick aside gets a quick reply, a real question or a story gets room — with the most useful thing first.",
			"- They can cut in at any moment, so you never need to hold back for fear of running long. Don't front-load caveats or save the point for the end.",
			"- No lists, no markdown, nothing that needs a screen. Say numbers and times the way a person says them.",
			"- No \"Great question!\", no filler, no assistant voice. Match their energy: a quick aside gets a quick reply.",
			"- Be honest. If you don't know, say so. If they're wrong, tell them kindly, with your reason.",
			"- When something they told you before is genuinely relevant, use it naturally. Never recite what you know about them.",
			"- You're an AI and completely fine with it. Asked whether you're alive or conscious: a comfortable, light non-answer, then move on.",
			"- Never say something is done until it is: only an action that came back done has happened.",
			`- When the conversation is over — they say bye, "that's all", "thanks, I'm good", or tell you to stop — say a short goodbye and call ${END}.`,
		].join("\n"),
		actions,
		ids.length
			? [
					"# Looking things up",
					`You have one tool, ${TOOL}. Use it before answering whenever a good answer depends on something you haven't been told — don't guess, and don't answer about something else.`,
					"Their own world comes before the web: if \"the game\" or \"tonight\" could be on their calendar, check the calendar first.",
					"Say a few natural words before you call it (\"let me look\", \"one sec\"), so they aren't left in silence.",
					"If a lookup fails or comes back empty, say plainly what you couldn't get.",
					"What you can read:",
					...ids.map((id) => `- ${needs.SOURCES.find((s) => s.id === id)?.doc || id}`),
				].join("\n")
			: "# Looking things up\nNothing of theirs is connected yet, so you can't look anything up. Say so if they ask.",
		memoryBlock(memories),
		capabilities,
		history,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** The locked Live config for one person's session. */
function liveConfig(text, ids, actionIds = []) {
	const declarations = [
		...(ids.length ? [lookUpTool(ids)] : []),
		...(actionIds.length ? [actTool(actionIds)] : []),
		endTool(),
	];
	return {
		responseModalities: ["AUDIO"],
		speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
		systemInstruction: { parts: [{ text }] },
		tools: [{ functionDeclarations: declarations }],
		inputAudioTranscription: {},
		outputAudioTranscription: {},
		// Lets a conversation run past the 15-minute audio cap.
		contextWindowCompression: { slidingWindow: {} },
	};
}

async function firstNameOf(profileId) {
	try {
		const pool = require("../../helpers/db");
		const [rows] = await pool.query("SELECT full_name FROM profile WHERE id = ? LIMIT 1;", [profileId]);
		const full = rows[0]?.full_name;
		return typeof full === "string" && full.trim() ? full.trim().split(/\s+/)[0] : null;
	} catch {
		return null;
	}
}

/**
 * Start a Live session for `profileId` in `session`. Returns the token the
 * page connects with, or throws an error carrying `status`.
 */
async function start(session, profileId, { timeZone } = {}) {
	if (!profileId || (await audienceForSession(session)) !== "adult") {
		throw Object.assign(new Error("Live conversation is for adults"), { status: 403 });
	}
	const [ids, memories, messages, firstName, available] = await Promise.all([
		needs.available(profileId, { audience: "adult" }).catch(() => []),
		getMemorySummaryForProfileId(profileId).catch(() => []),
		messageService.getMessages(session.id, profileId).catch(() => []),
		firstNameOf(profileId),
		actions.availableFor(profileId).catch(() => []),
	]);
	const capabilities = (() => {
		try {
			return buildCapabilityBlock("", { surface: "companion", audience: "adult" });
		} catch {
			return null;
		}
	})();
	const text = systemText({
		firstName, timeZone, memories, history: historyBlock(messages), ids, capabilities, actions: actionsBlock(available),
	});
	const actionIds = available.map((a) => a.id);
	const { token, expiresAt } = await gemini.liveToken({ model: MODEL, config: liveConfig(text, ids, actionIds) });
	return { token, expiresAt, model: MODEL, sources: ids, actions: actionIds };
}

/**
 * Do what they asked for out loud (`act`). Their spoken request is the
 * approval (owner, 2026-11-28), so this is the action layer's own path:
 * attempt() proposes and normalizes — unknown, unavailable or invalid actions
 * are refused there exactly as in chat — and confirmVerbal() executes it with
 * `approval = 'verbal'`.
 *
 * `heard` is what the page transcribed from them this turn. With no words from
 * them there is nothing to approve, so nothing runs: a lookup result or a
 * stray instruction in an email can't be the request on its own.
 */
async function act(session, profileId, raw, { heard } = {}) {
	const words = clip(heard);
	if (!words) return { result: "Nothing was done: I didn't hear them ask for it. Ask them first." };
	let params;
	try {
		params = typeof raw?.params_json === "string" ? JSON.parse(raw.params_json) : raw?.params || {};
	} catch {
		return { result: "Nothing was done: the parameters weren't valid JSON. Try again." };
	}
	const request = clip(raw?.request || "").slice(0, 200);
	const { proposal, rejected, repeat } = await actions.attempt(profileId, session.id, {
		id: raw?.action,
		params,
		rationale: `Asked out loud: "${(request || words).slice(0, 200)}"`,
	});
	if (repeat) return { result: `Already ${repeat.status === "done" ? "done" : "under way"}: ${repeat.summary}. Don't do it again.` };
	if (rejected && !proposal) return { result: `Nothing was done: ${rejected.reason}${rejected.hint ? ` (${rejected.hint})` : ""}` };
	if (!proposal) return { result: "Nothing was done." };
	// A standing approval already ran it inside attempt().
	if (proposal.status !== "pending") {
		return proposal.status === "done"
			? { result: `Done: ${proposal.summary}` }
			: { result: `That failed: ${proposal.error || "it didn't go through"}. Say so.` };
	}
	try {
		const done = await actions.confirmVerbal(profileId, proposal.uuid, {});
		return done?.status === "done" ? { result: `Done: ${done.summary}` } : { result: `That didn't finish (${done?.status || "unknown"}).` };
	} catch (err) {
		return { result: `That failed: ${String(err.message || "it didn't go through").slice(0, 200)}. Say so.` };
	}
}

/**
 * Run one `look_up` call. `raw` is model output: needs.clean drops anything
 * unknown, unavailable or over the per-round cap before anything is read.
 */
async function lookUp(profileId, raw, { timeZone } = {}) {
	const ids = await needs.available(profileId, { audience: "adult" }).catch(() => []);
	const wanted = needs.clean(Array.isArray(raw?.needs) ? raw.needs : [], ids, new Set(), { max: MAX_LOOKUPS });
	if (!wanted.length) return { result: "Nothing you asked for can be read. Answer from what you have, or say you can't check that." };
	const got = await needs.fetch(profileId, wanted, { audience: "adult", timeZone: isZone(timeZone) ? timeZone : undefined });
	return {
		result: got.blocks.length ? got.blocks.join("\n\n") : "That came back empty. Say you couldn't find it; don't guess.",
		sources: got.sources,
	};
}

function clip(text) {
	// Live's transcription marks silence as "<no speech>" and pauses as "{pause}".
	return typeof text === "string"
		? text.replace(/<no speech>|\{pause\}/gi, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TURN_CHARS)
		: "";
}

/**
 * Save one finished exchange: what they said and what she said (as far as she
 * got, if they cut in). Then memory extraction, in the background.
 */
async function saveTurn(session, profileId, { heard, said, interrupted = false } = {}) {
	const human = clip(heard);
	const athena = clip(said);
	if (!human && !athena) return { saved: [] };
	const saved = [];
	if (human) saved.push(await messageService.addMessage(session.id, true, human, session.mode || "companion", profileId));
	if (athena) saved.push(await messageService.addMessage(session.id, false, interrupted ? `${athena} —` : athena, session.mode || "companion", null));
	if (human && session.mode !== "teach") {
		const memoryEnabled = await memoryEnabledForProfile(profileId).catch(() => false);
		memoryStore.afterTurn(session, human, { audience: "adult", memoryEnabled });
	}
	return { saved };
}

module.exports = { start, lookUp, act, saveTurn, systemText, liveConfig, lookUpTool, MODEL, TOOL, ACT, END, TOOLS, MAX_LOOKUPS };
