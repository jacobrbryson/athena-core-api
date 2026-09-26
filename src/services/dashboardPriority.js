/**
 * The dashboard's card order, and whether anything deserves the alert banner.
 *
 * The order is FIXED. It used to be a model ranking; the owner removed that on
 * 2026-09-26 — "keep my health and performance first, remove the logic that
 * lets the LLM auto-sort". Do not reintroduce a model ordering.
 *
 * What is still asked of the model is only the alert: given a small,
 * structured description of every card (counts, the next thing on the clock,
 * whether a source is connected), is anything serious enough to put across
 * the top of the screen? The emergency situation floors that answer.
 *
 * Deliberately conservative:
 *   - It never throws. A dashboard that fails to load because the model was
 *     down would be worse than one without an alert.
 *   - It runs on the local-first `json` task and is cached per profile, because
 *     this fires on every dashboard open and must not become an expensive habit.
 */
const llm = require("./llm");
const dashboard = require("./dashboard");
const actions = require("./actions");
const readCache = require('./readCache');

// The card set, in the one order the dashboard uses. Changing these ids means
// changing components/Dashboard.tsx in the companion app with them.
const CARDS = [
	{ id: "health", title: "Health & Performance" },
	{ id: "calendar", title: "Calendar" },
	{ id: "family", title: "Family" },
	{ id: "mail", title: "Mail" },
	{ id: "work", title: "Work" },
	{ id: "news", title: "News & Updates" },
	{ id: "projects", title: "Projects" },
	{ id: "notifications", title: "Notifications" },
];
const DEFAULT_ORDER = CARDS.map((c) => ({ id: c.id, why: null }));

const CACHE_TTL_MS = 10 * 60 * 1000;

const MINUTE = 60_000;
const latest = (rows) =>
	[...(rows || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null;

/** Minutes until an event starts — negative once it is under way, null if unparseable. */
function minutesUntil(start) {
	const at = Date.parse(start || "");
	return Number.isFinite(at) ? Math.round((at - Date.now()) / MINUTE) : null;
}

/**
 * The signal sheet the model reads for the alert: counts and the few facts that actually
 * change an ordering, never the raw provider payloads. Keeping it this small
 * is what makes the call cheap enough to run on every dashboard open.
 */
function describe(summary, pendingCount) {
	const status = (key) => summary?.[key]?.status || "error";
	const events = summary?.calendar?.data?.events || [];
	const next = events[0];
	const recovery = latest(summary?.recovery?.data?.filter((r) => r.state === "SCORED"));
	const sleep = latest(summary?.sleep?.data?.filter((s) => !s.nap));
	const chores = summary?.familyChores?.data?.chores || [];
	const issues = summary?.jira?.data?.issues || [];
	const mentions = summary?.slack?.data?.messages?.length ?? null;
	const emailNew = summary?.emailTriage?.data?.newCount ?? null;
	const strain = latest(summary?.strain?.data)?.day_strain ?? null;
	const activities = summary?.activity?.data?.activities?.length ?? null;

	return [
		{
			id: "calendar",
			title: "Calendar",
			source: status("calendar"),
			empty: events.length === 0,
			signals: {
				eventsNext7Days: events.length,
				nextEventTitle: next?.title || null,
				nextEventInMinutes: next ? minutesUntil(next.start) : null,
				nextEventIsAllDay: next ? !!next.allDay : null,
			},
		},
		{
			id: "health",
			title: "Health & Performance",
			source: status("recovery"),
			empty:
				recovery?.recovery_score == null &&
				sleep == null &&
				strain == null &&
				!(activities > 0),
			signals: {
				recoveryScore: recovery?.recovery_score ?? null,
				hoursAsleepLastNight: sleep ? Math.round(sleep.hours_asleep * 10) / 10 : null,
				dayStrain: strain,
				recentActivities: activities,
			},
		},
		{
			id: "family",
			title: "Family",
			source: status("familyChores"),
			empty: chores.length === 0,
			signals: {
				choresToday: chores.length,
				choresOutstanding: chores.filter((c) => !c.completed).length,
			},
		},
		{
			id: "mail",
			title: "Mail",
			source: status("emailTriage"),
			empty: !(emailNew > 0),
			signals: {
				newTriagedEmails: emailNew,
				receipts: summary?.emailTriage?.data?.receiptCount ?? null,
				travelOrSchool: (summary?.emailTriage?.data?.travelCount ?? 0) + (summary?.emailTriage?.data?.schoolCount ?? 0),
			},
		},
		{
			id: "work",
			title: "Work",
			source: status("jira"),
			// Two sub-sources, either of which can carry the card. Jira being
			// unlinked says nothing about whether there are Slack mentions.
			empty: !issues.length && !(mentions > 0),
			signals: {
				assignedOpenIssues: issues.length,
				slackMentions: mentions,
			},
		},
		{
			id: "news",
			title: "News & Updates",
			source: "ready",
			// null, not false: the feeds are read from a different endpoint, so
			// this sheet genuinely cannot say whether there is anything in them.
			// Never treated as empty, and so never demoted for looking it.
			empty: null,
			signals: { note: "Background reading from the news pages this person chose." },
		},
		{
			id: "projects",
			title: "Projects",
			source: status("jira"),
			empty: issues.length === 0,
			signals: { activeProjects: new Set(issues.map((i) => i.project)).size },
		},
		{
			id: "notifications",
			title: "Notifications",
			source: "ready",
			empty: !pendingCount,
			signals: {
				awaitingYourApproval: pendingCount,
				// Phrased from the count. The old note described a waiting
				// decision whether or not one existed, and an empty bell then
				// read as the most urgent thing on the page.
				note: pendingCount
					? "Things Athena has offered to do and cannot do until approved."
					: "Nothing is waiting on a decision.",
			},
		},
	];
}

const PROMPT = (cards, emergencies = null) =>
	`These are the cards on someone's personal dashboard right now, with the live ` +
	`signals behind each one:

${JSON.stringify(cards, null, 1)}

` +
	(emergencies
		? `Emergency calls near their home right now:
` +
			`${JSON.stringify(emergencies, null, 1)}

`
		: "") +
	`Decide whether anything here is serious enough to put a big alert across ` +
	`the top of their screen the moment they open it — something they would be upset ` +
	`to find out about later. Ongoing emergencies near their home always are. A card ` +
	`marked "empty": true has nothing behind it and cannot be the reason. Most ` +
	`days nothing is: use null.

` +
	`Answer as JSON:
` +
	`{"alert":null or {"level":"watch" or "urgent","headline":"at most 8 words","body":"at most 40 words, addressed to them"}}`;

/**
 * The alert the model raised, floored by the emergency situation.
 *
 * The model reads the whole dashboard and may raise an alert about anything.
 * It may not LOWER one the incident watcher already judged: an urgent
 * situation near home is urgent on the banner whatever the ranking call
 * thought, and if the model said nothing the situation's own words are used.
 */
function mergeAlert(raw, situation) {
	const RANK = { watch: 1, urgent: 2 };
	const fromModel =
		raw && RANK[raw.level] && typeof raw.headline === "string" && raw.headline.trim()
			? {
					level: raw.level,
					headline: raw.headline.trim().slice(0, 200),
					body: typeof raw.body === "string" ? raw.body.trim().slice(0, 600) : "",
					source: "athena",
				}
			: null;
	const floor =
		situation && RANK[situation.level]
			? { level: situation.level, headline: situation.headline, body: situation.body, source: "emergencies" }
			: null;
	if (!floor) return fromModel;
	if (!fromModel || RANK[fromModel.level] < RANK[floor.level]) return floor;
	return fromModel;
}

/**
 * The fixed card order and the alert for this profile. Always resolves.
 * `source` says where the alert judgement came from.
 */
async function getPriority(profileId, user) {
	// The emergency situation first: it is the floor under the alert, and it
	// must stand even when the dashboard or the model cannot be reached.
	const situation = await require("./pulsepoint/watch").getSituation(profileId).catch(() => null);
	const fallback = () => ({
		order: DEFAULT_ORDER,
		source: "default",
		alert: mergeAlert(null, situation),
		generatedAt: new Date().toISOString(),
	});
	const emergencies =
		situation && situation.level !== "none" && situation.incidents?.length
			? {
					level: situation.level,
					calls: situation.incidents
						.slice(0, 10)
						.map((i) => ({ what: i.what, where: i.where, miles: i.miles, units: i.units })),
				}
			: null;

	let summary = dashboard.cachedDashboard(profileId);
	if (!summary) {
		try {
			summary = await dashboard.getDashboard(profileId, user);
		} catch {
			return fallback();
		}
	}
	const pending = await actions.listPending(profileId).catch(() => []);
	const cards = describe(summary, pending.length);
	// Reuse only an identical signal sheet and prompt, not merely a profile.
	const inputKey = readCache.hash(['dashboard-alert-v1', PROMPT(cards, emergencies)]);

	// Nothing on the page has anything in it. Usually this is a snapshot taken
	// before the providers answered — no model call, and nothing cached. Not
	// when there are emergencies: then there is something to say regardless.
	if (cards.every((c) => c.empty !== false) && !emergencies) {
		return fallback();
	}

	try {
		const value = await readCache.read({ profileId, namespace: 'dashboard-order', key: inputKey, ttlMs: CACHE_TTL_MS }, async () => {
			const { data, model } = await llm.generateJson({
				task: "json",
				contents: [{ role: "user", parts: [{ text: PROMPT(cards, emergencies) }] }],
				check: (parsed) =>
					parsed && typeof parsed === "object" && "alert" in parsed ? true : 'answer must be {"alert": ...}',
			});
			return {
				order: DEFAULT_ORDER,
				alert: data?.alert ?? null,
				source: "athena",
				model: model || null,
				generatedAt: new Date().toISOString(),
			};
		});
		return { ...value, alert: mergeAlert(value.alert, situation) };
	} catch (err) {
		console.warn("[dashboard] alert assessment unavailable:", err.message);
		// Not cached: the next open should get a real judgement if the model is back.
		return fallback();
	}
}

/** Drop the memoised judgement so the next read re-assesses (used when the data moves). */
function invalidate(profileId) {
	return readCache.invalidate(profileId, 'dashboard-order');
}

module.exports = { getPriority, invalidate, mergeAlert, CARDS };
