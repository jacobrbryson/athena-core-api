const { providerGet } = require("./http");

/**
 * Whoop reads — recovery, sleep and strain.
 *
 * Whoop v2 collections all take start/end/limit and page with nextToken;
 * limit is capped at 25 by the API, so asking for more is a paging problem,
 * not a bigger request. Athena reads one page: recent history is what a
 * conversation needs, and anything deeper belongs in a report, not a prompt.
 */

const PROVIDER = "whoop";
const MAX_LIMIT = 25; // Whoop's own ceiling

/**
 * The collection reads do not judge link health.
 *
 * A dashboard load fans out over recovery, sleep and cycles at once, and one
 * of them answering 401 says something about that collection's scope — not
 * about the grant. Letting it flag the link is what made a missing
 * `read:cycles` present itself as "access expired" on every page refresh,
 * while recovery and sleep were answering perfectly.
 *
 * Link health is judged by getProfile(), the account-level read a real
 * revocation fails first, and by the token endpoint rejecting a refresh.
 */
const COLLECTION_READ = { invalidateOnAuthFailure: false };

const KEYWORDS =
	/\b(whoop|workouts?|activity reviews?|recovery|recovered|strain|sleep|slept|sleeping|hrv|heart rate variability|resting heart rate|rhr|respiratory rate|readiness|rested|tired|fatigue)\b/i;

function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

function since(days) {
	const lookback = Math.max(1, Math.min(Number(days) || 7, 90));
	// Stable lower bound for a short read-cache window (at most 30s wider).
	return new Date(Math.floor(Date.now() / 30000) * 30000 - lookback * 86400_000).toISOString();
}

function limitOf(value, fallback = 10) {
	return Math.min(Math.max(Number(value) || fallback, 1), MAX_LIMIT);
}

/** The account's basic profile — also how a Whoop link learns its account id. */
async function getProfile(profileId) {
	const data = await providerGet(profileId, PROVIDER, "/v2/user/profile/basic");
	if (!data) return null;
	return {
		user_id: data.user_id ?? null,
		first_name: data.first_name || null,
		last_name: data.last_name || null,
		email: data.email || null,
	};
}

/** Daily recovery scores: how ready the body is. */
async function listRecovery(profileId, { days = 7, limit } = {}) {
	const data = await providerGet(profileId, PROVIDER, "/v2/recovery", {
		...COLLECTION_READ,
		query: { start: since(days), limit: limitOf(limit) },
	});
	return (data?.records || []).map((r) => ({
		date: String(r.created_at || "").slice(0, 10),
		recovery_score: r.score?.recovery_score ?? null,
		resting_heart_rate: r.score?.resting_heart_rate ?? null,
		hrv_ms: r.score?.hrv_rmssd_milli ?? null,
		spo2_percent: r.score?.spo2_percentage ?? null,
		state: r.score_state || null,
	}));
}

/** Sleep sessions with duration and efficiency. */
async function listSleep(profileId, { days = 7, limit } = {}) {
	const data = await providerGet(profileId, PROVIDER, "/v2/activity/sleep", {
		...COLLECTION_READ,
		query: { start: since(days), limit: limitOf(limit) },
	});
	return (data?.records || []).map((r) => {
		const stage = r.score?.stage_summary || {};
		const inBedMs = Number(stage.total_in_bed_time_milli) || 0;
		const awakeMs = Number(stage.total_awake_time_milli) || 0;
		return {
			date: String(r.end || r.start || "").slice(0, 10),
			nap: r.nap === true,
			hours_in_bed: Number((inBedMs / 3_600_000).toFixed(2)),
			hours_asleep: Number(((inBedMs - awakeMs) / 3_600_000).toFixed(2)),
			sleep_performance_percent: r.score?.sleep_performance_percentage ?? null,
			sleep_efficiency_percent: r.score?.sleep_efficiency_percentage ?? null,
			respiratory_rate: r.score?.respiratory_rate ?? null,
		};
	});
}

/** Workouts as Whoop scores them — strain, not distance. */
async function listWorkouts(profileId, { days = 7, limit } = {}) {
	const data = await providerGet(profileId, PROVIDER, "/v2/activity/workout", {
		...COLLECTION_READ,
		query: { start: since(days), limit: limitOf(limit) },
	});
	return (data?.records || []).map(normalizeWorkout);
}

function normalizeWorkout(r) {
	return {
		id: r.id || null, user_id: r.user_id ?? null,
		start: r.start || null, end: r.end || null,
		created_at: r.created_at || null, updated_at: r.updated_at || null,
		timezone_offset: r.timezone_offset || null, score_state: r.score_state || null,
		date: String(r.start || "").slice(0, 10),
		sport: r.sport_name || r.sport_id || "Workout",
		strain: r.score?.strain ?? null,
		average_heart_rate: r.score?.average_heart_rate ?? null,
		max_heart_rate: r.score?.max_heart_rate ?? null,
		kilojoules: r.score?.kilojoule ?? null,
	};
}

// Single-resource reads are deliberately not in the shared HTTP cache allowlist:
// a webhook means the provider may have changed since the last dashboard read.
async function getWorkout(profileId, id) {
	if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid WHOOP workout ID');
	return normalizeWorkout(await providerGet(profileId, PROVIDER, `/v2/activity/workout/${encodeURIComponent(id)}`, COLLECTION_READ));
}

async function workoutPage(profileId, { start, end, nextToken } = {}) {
	const data = await providerGet(profileId, PROVIDER, '/v2/activity/workout', {
		...COLLECTION_READ, query: { start, end, nextToken, limit: MAX_LIMIT },
	});
	if (!Array.isArray(data?.records)) throw new Error('Invalid WHOOP workout page');
	return { records: data.records.map(normalizeWorkout), nextToken: data.next_token || null };
}

/** Daily physiological cycles, which carry day strain. */
async function listCycles(profileId, { days = 7, limit } = {}) {
	const data = await providerGet(profileId, PROVIDER, "/v2/cycle", {
		...COLLECTION_READ,
		query: { start: since(days), limit: limitOf(limit) },
	});
	return (data?.records || []).map((r) => ({
		date: String(r.start || "").slice(0, 10),
		day_strain: r.score?.strain ?? null,
		average_heart_rate: r.score?.average_heart_rate ?? null,
		kilojoules: r.score?.kilojoule ?? null,
	}));
}

function formatRecovery(r) {
	const bits = [
		r.recovery_score !== null ? `recovery ${r.recovery_score}%` : null,
		r.hrv_ms !== null ? `HRV ${Math.round(r.hrv_ms)}ms` : null,
		r.resting_heart_rate !== null ? `RHR ${Math.round(r.resting_heart_rate)}` : null,
	].filter(Boolean);
	return `- ${r.date} — ${bits.join(", ") || "no score"}`;
}

function formatSleep(s) {
	const bits = [
		`${s.hours_asleep}h asleep`,
		s.sleep_performance_percent !== null
			? `performance ${s.sleep_performance_percent}%`
			: null,
		s.nap ? "(nap)" : null,
	].filter(Boolean);
	return `- ${s.date} — ${bits.join(", ")}`;
}

/**
 * Grounding block for the system prompt. Each section is fetched
 * independently so one failing endpoint does not lose the others.
 *
 * One section failing is survivable — the other still answers. Both failing
 * is not, and rethrows rather than returning null: null reads to the caller
 * as "nothing to say", which is how a total outage came to be presented as a
 * quiet week. The caller turns the throw into an explicit "Whoop could not be
 * read" line for the prompt.
 */
async function buildContext(profileId, { days = 7 } = {}) {
	const results = await Promise.all([
		listRecovery(profileId, { days }).catch((err) => ({ error: err })),
		listSleep(profileId, { days }).catch((err) => ({ error: err })),
	]);
	const failure = results.find((r) => r && r.error);
	if (failure && results.every((r) => r && r.error)) throw failure.error;

	const [recovery, sleep] = results.map((r) => (r && r.error ? null : r));
	if (!recovery && !sleep) return null;

	const lines = [`Whoop — last ${days} days:`];
	if (recovery?.length) {
		lines.push("Recovery, newest first:", ...recovery.map(formatRecovery));
	}
	if (sleep?.length) {
		lines.push("Sleep, newest first:", ...sleep.map(formatSleep));
	}
	const interpretations = await require('../attention').promptBlock(profileId).catch(() => null);
	if (interpretations) lines.push(interpretations);
	if (lines.length === 1) return `Whoop: no data recorded in the last ${days} days.`;
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Gemini tools
// ---------------------------------------------------------------------------

const FUNCTION_DECLARATIONS = [
	{
		name: "get_whoop_recovery",
		description:
			"Daily Whoop recovery scores with HRV, resting heart rate and SpO2. " +
			'Use for "how recovered am I", "how is my HRV", "should I train hard ' +
			'today", or any readiness question. Newest first.',
		parameters: {
			type: "OBJECT",
			properties: {
				days: {
					type: "NUMBER",
					description: "How many days back to look. Maximum 90; at most 25 records.",
				},
			},
		},
	},
	{
		name: "get_whoop_sleep",
		description:
			"Whoop sleep sessions with hours asleep, sleep performance and " +
			'efficiency. Use for "how did I sleep", "how much sleep did I get", or ' +
			"sleep trend questions. Naps are flagged separately.",
		parameters: {
			type: "OBJECT",
			properties: {
				days: {
					type: "NUMBER",
					description: "How many days back to look. Maximum 90; at most 25 records.",
				},
			},
		},
	},
	{
		name: "get_whoop_strain",
		description:
			"Whoop strain: per-workout strain scores and daily overall strain. Use " +
			'for "how hard did I go", "what was my strain", or load questions. ' +
			"Strain is Whoop's cardiovascular load scale (0-21), not distance — for " +
			"distance or pace use the Strava tools instead.",
		parameters: {
			type: "OBJECT",
			properties: {
				days: {
					type: "NUMBER",
					description: "How many days back to look. Maximum 90.",
				},
			},
		},
	},
];

async function executeTool(name, args = {}, { profileId }) {
	if (name === "get_whoop_recovery") {
		return { recovery: await listRecovery(profileId, { days: args.days }) };
	}
	if (name === "get_whoop_sleep") {
		return { sleep: await listSleep(profileId, { days: args.days }) };
	}
	if (name === "get_whoop_strain") {
		const [workouts, cycles] = await Promise.all([
			listWorkouts(profileId, { days: args.days }),
			listCycles(profileId, { days: args.days }),
		]);
		return { workouts, daily: cycles };
	}
	throw new Error(`Unknown Whoop tool: ${name}`);
}

module.exports = {
	normalizeWorkout,
	getWorkout,
	workoutPage,
	PROVIDER,
	matches,
	getProfile,
	listRecovery,
	listSleep,
	listWorkouts,
	listCycles,
	buildContext,
	FUNCTION_DECLARATIONS,
	executeTool,
};
