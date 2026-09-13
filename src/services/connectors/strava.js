const { providerGet } = require("./http");

/**
 * Strava reads — recent activities and rolled-up weekly totals.
 *
 * Totals are computed here from the activity list rather than read from
 * /athletes/{id}/stats, because that endpoint reports all-time and
 * year-to-date figures on a recent-4-weeks basis that does not line up with
 * "this week" as a person means it. Summing the activities we already have is
 * one fewer call and answers the question actually asked.
 */

const PROVIDER = "strava";
const MAX_ACTIVITIES = 30;

const KEYWORDS =
	/\b(strava|workout|workouts|run|ran|running|ride|rode|riding|cycl\w*|swim|swam|swimming|train(ing|ed)?|exercis\w*|mileage|miles|kilometers|km|pace|elevation|activity|activities)\b/i;

function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

const METERS_PER_MILE = 1609.344;

/**
 * Recent activities, newest first.
 * `after` is an epoch-seconds lower bound, which is how Strava filters.
 */
async function listActivities(profileId, { days = 14, perPage = MAX_ACTIVITIES } = {}) {
	const lookback = Math.max(1, Math.min(Number(days) || 14, 365));
	const after = Math.floor((Date.now() - lookback * 86400_000) / 1000);
	const data = await providerGet(profileId, PROVIDER, "/athlete/activities", {
		query: {
			after,
			per_page: Math.min(Number(perPage) || MAX_ACTIVITIES, 100),
		},
	});
	return (Array.isArray(data) ? data : []).map(normalizeActivity);
}

function normalizeActivity(a) {
	return {
		name: a.name || "(untitled)",
		type: a.sport_type || a.type || "Workout",
		start: a.start_date_local || a.start_date || null,
		distance_m: Math.round(Number(a.distance) || 0),
		distance_mi: Number(((Number(a.distance) || 0) / METERS_PER_MILE).toFixed(2)),
		moving_time_s: Math.round(Number(a.moving_time) || 0),
		elevation_gain_m: Math.round(Number(a.total_elevation_gain) || 0),
		average_heartrate: a.average_heartrate ?? null,
		suffer_score: a.suffer_score ?? null,
	};
}

/** Totals over the fetched window, plus a per-sport breakdown. */
function summarize(activities) {
	const totals = {
		count: activities.length,
		distance_mi: 0,
		moving_time_s: 0,
		elevation_gain_m: 0,
	};
	const bySport = {};
	for (const a of activities) {
		totals.distance_mi += a.distance_mi;
		totals.moving_time_s += a.moving_time_s;
		totals.elevation_gain_m += a.elevation_gain_m;
		const sport = (bySport[a.type] ||= { count: 0, distance_mi: 0, moving_time_s: 0 });
		sport.count += 1;
		sport.distance_mi += a.distance_mi;
		sport.moving_time_s += a.moving_time_s;
	}
	totals.distance_mi = Number(totals.distance_mi.toFixed(2));
	for (const sport of Object.values(bySport)) {
		sport.distance_mi = Number(sport.distance_mi.toFixed(2));
	}
	return { totals, bySport };
}

function duration(seconds) {
	const h = Math.floor(seconds / 3600);
	const m = Math.round((seconds % 3600) / 60);
	return h ? `${h}h ${m}m` : `${m}m`;
}

function formatActivity(a) {
	const day = String(a.start || "").slice(0, 10);
	const distance = a.distance_mi > 0 ? `, ${a.distance_mi} mi` : "";
	const hr = a.average_heartrate ? `, avg HR ${Math.round(a.average_heartrate)}` : "";
	return `- ${day} — ${a.type}: ${a.name}${distance}, ${duration(a.moving_time_s)}${hr}`;
}

/** Grounding block for the system prompt. */
async function buildContext(profileId, { days = 14 } = {}) {
	const activities = await listActivities(profileId, { days });
	if (!activities.length) {
		return `Strava: no activities recorded in the last ${days} days.`;
	}
	const { totals, bySport } = summarize(activities);
	const sports = Object.entries(bySport)
		.map(([sport, s]) => `${sport} ×${s.count} (${s.distance_mi} mi)`)
		.join(", ");

	return [
		`Strava — last ${days} days:`,
		`Totals: ${totals.count} activities, ${totals.distance_mi} mi, ` +
			`${duration(totals.moving_time_s)} moving, ${totals.elevation_gain_m} m climbed.`,
		`By sport: ${sports}`,
		"Activities, newest first:",
		...activities.map(formatActivity),
	].join("\n");
}

// ---------------------------------------------------------------------------
// Gemini tools
// ---------------------------------------------------------------------------

const FUNCTION_DECLARATIONS = [
	{
		name: "get_strava_activities",
		description:
			"List the user's recent Strava activities (runs, rides, swims, etc.) " +
			"with distance, moving time, elevation and average heart rate. Use for " +
			"any question about what they trained, how far, how long, or how a " +
			"particular workout went. Newest first.",
		parameters: {
			type: "OBJECT",
			properties: {
				days: {
					type: "NUMBER",
					description:
						"How many days back to look. Use 7 for this week, 30 for this " +
						"month. Maximum 365.",
				},
			},
		},
	},
	{
		name: "get_strava_totals",
		description:
			"Rolled-up training totals over a window: activity count, total miles, " +
			"total moving time, total elevation, and a per-sport breakdown. Use for " +
			'"how much did I run this week", "how many miles", or trend questions, ' +
			"rather than listing every activity.",
		parameters: {
			type: "OBJECT",
			properties: {
				days: {
					type: "NUMBER",
					description: "Window length in days. Use 7 for this week. Maximum 365.",
				},
			},
		},
	},
];

async function executeTool(name, args = {}, { profileId }) {
	if (name === "get_strava_activities") {
		return { activities: await listActivities(profileId, { days: args.days }) };
	}
	if (name === "get_strava_totals") {
		const activities = await listActivities(profileId, { days: args.days });
		const { totals, bySport } = summarize(activities);
		return { window_days: args.days || 14, totals, by_sport: bySport };
	}
	throw new Error(`Unknown Strava tool: ${name}`);
}

module.exports = {
	PROVIDER,
	matches,
	listActivities,
	summarize,
	buildContext,
	FUNCTION_DECLARATIONS,
	executeTool,
	// exported for tests
	normalizeActivity,
};
