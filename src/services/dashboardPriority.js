/**
 * What deserves the person's attention first.
 *
 * The dashboard's cards are always the same seven; which one they should read
 * first is not. This hands the model a small, structured description of every
 * card — counts, the next thing on the clock, whether a source is even
 * connected — and asks for the same list back in priority order, each with a
 * one-line reason.
 *
 * Deliberately conservative:
 *   - It never invents or drops a card. The model's answer is treated as an
 *     ordering hint over a fixed set; unknown ids are discarded and missing
 *     ids are appended in the default order.
 *   - It never throws. A dashboard that fails to load because the model was
 *     down would be a worse dashboard than one in its default order.
 *   - It runs on the local-first `json` task and is cached per profile, because
 *     this fires on every dashboard open and must not become an expensive habit.
 */
const llm = require("./llm");
const dashboard = require("./dashboard");
const actions = require("./actions");

// The card set, in the order the dashboard falls back to. Changing these ids
// means changing components/Dashboard.tsx in the companion app with them.
const CARDS = [
	{ id: "calendar", title: "Calendar" },
	{ id: "health", title: "Health & Performance" },
	{ id: "family", title: "Family" },
	{ id: "work", title: "Work" },
	{ id: "news", title: "News & Updates" },
	{ id: "projects", title: "Projects" },
	{ id: "notifications", title: "Notifications" },
];
const CARD_IDS = new Set(CARDS.map((c) => c.id));
const DEFAULT_ORDER = CARDS.map((c) => ({ id: c.id, why: null }));

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // profileId => { at, value }

const MINUTE = 60_000;
const latest = (rows) =>
	[...(rows || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null;

/** Minutes until an event starts — negative once it is under way, null if unparseable. */
function minutesUntil(start) {
	const at = Date.parse(start || "");
	return Number.isFinite(at) ? Math.round((at - Date.now()) / MINUTE) : null;
}

/**
 * The signal sheet the model ranks on: counts and the few facts that actually
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
	const mail = summary?.gmail?.data?.messages?.length ?? null;
	const mentions = summary?.slack?.data?.messages?.length ?? null;
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
			id: "work",
			title: "Work",
			source: status("jira"),
			// Three sub-sources, any one of which can carry the card. Jira being
			// unlinked says nothing about whether there is unread mail.
			empty: !issues.length && !(mail > 0) && !(mentions > 0),
			signals: {
				assignedOpenIssues: issues.length,
				unreadInboxMessages: mail,
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
			signals: { note: "Background reading from the person's own RSS feeds." },
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

const PROMPT = (cards) =>
	`These are the cards on someone's personal dashboard right now, with the live ` +
	`signals behind each one:\n\n${JSON.stringify(cards, null, 1)}\n\n` +
	`Put them in the order this person should look at them, most important first.\n\n` +
	`Weigh it the way a thoughtful assistant would:\n` +
	`- A card marked "empty": true has nothing behind it right now. It cannot ` +
	`be urgent, whatever its title suggests, and belongs below every card that ` +
	`has something in it.\n` +
	`- Something starting very soon, or already under way, beats everything.\n` +
	`- A decision only they can make outranks information — when there is one ` +
	`actually waiting.\n` +
	`- A source that is not connected, or has nothing in it, sinks.\n` +
	`- Low recovery next to a heavy day is worth raising; a good night is not.\n` +
	`- Background reading comes last unless nothing else needs them.\n\n` +
	`Return every id exactly once, no others, as JSON:\n` +
	`{"order":[{"id":"...","why":"under 12 words, addressed to them"}]}`;

/**
 * An empty card may not outrank one with something in it.
 *
 * The prompt asks for this, but asking is not enough: "Notifications" reads as
 * urgent on its name alone, and an empty bell was ranking above a calendar
 * with the day's meetings in it. Emptiness is knowable here without a model,
 * so it is decided here — and the order the model chose survives intact within
 * each group.
 *
 * `empty: null` (News, whose feeds this sheet cannot see) never sinks.
 *
 * A card that falls only because it is empty also loses its reason: whatever
 * the model wrote to justify raising it described content that is not there,
 * and "2 approvals need you" under an empty card is worse than no line at all.
 */
function applyEmptyFloor(order, empty) {
	const filled = order.filter((e) => empty.get(e.id) !== true);
	const blank = order.filter((e) => empty.get(e.id) === true);
	if (!filled.length || !blank.length) return order;

	const wasAt = new Map(order.map((e, i) => [e.id, i]));
	return [...filled, ...blank].map((entry, i) =>
		empty.get(entry.id) === true && i !== wasAt.get(entry.id)
			? { ...entry, why: null }
			: entry
	);
}

/** Coerce a model answer into a complete, duplicate-free ordering of CARDS. */
function normalize(raw) {
	const seen = new Set();
	const order = [];
	for (const entry of Array.isArray(raw) ? raw : []) {
		const id = typeof entry === "string" ? entry : entry?.id;
		if (!CARD_IDS.has(id) || seen.has(id)) continue;
		seen.add(id);
		const why = typeof entry?.why === "string" ? entry.why.trim().slice(0, 120) : null;
		order.push({ id, why: why || null });
	}
	for (const card of CARDS) if (!seen.has(card.id)) order.push({ id: card.id, why: null });
	return order;
}

/**
 * The card order for this profile. Always resolves, always complete.
 * `reason` says where the order came from so the client can stay quiet about
 * an ordering nobody chose.
 */
async function getPriority(profileId, user) {
	const hit = cache.get(profileId);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

	let summary = dashboard.cachedDashboard(profileId);
	if (!summary) {
		try {
			summary = await dashboard.getDashboard(profileId, user);
		} catch {
			return { order: DEFAULT_ORDER, source: "default", generatedAt: new Date().toISOString() };
		}
	}
	const pending = await actions.listPending(profileId).catch(() => []);
	const cards = describe(summary, pending.length);
	const empty = new Map(cards.map((c) => [c.id, c.empty]));

	// Nothing on the page has anything in it. Usually this is a snapshot taken
	// before the providers answered, and there is no "more important" to find —
	// so leave the order alone rather than spend a model call shuffling empties
	// and then cache the result for ten minutes.
	if (cards.every((c) => c.empty !== false)) {
		return { order: DEFAULT_ORDER, source: "default", generatedAt: new Date().toISOString() };
	}

	try {
		const { data, model } = await llm.generateJson({
			task: "json",
			contents: [{ role: "user", parts: [{ text: PROMPT(cards) }] }],
			check: (parsed) => {
				const ids = (Array.isArray(parsed?.order) ? parsed.order : [])
					.map((e) => (typeof e === "string" ? e : e?.id))
					.filter((id) => CARD_IDS.has(id));
				return new Set(ids).size === CARDS.length ? true : "order must list every card id exactly once";
			},
		});
		const value = {
			order: applyEmptyFloor(normalize(data?.order), empty),
			source: "athena",
			model: model || null,
			generatedAt: new Date().toISOString(),
		};
		cache.set(profileId, { at: Date.now(), value });
		return value;
	} catch (err) {
		console.warn("[dashboard] prioritisation unavailable:", err.message);
		// Not cached: the next open should get a real ordering if the model is back.
		return { order: DEFAULT_ORDER, source: "default", generatedAt: new Date().toISOString() };
	}
}

/** Drop the memoised order so the next read re-ranks (used when the data moves). */
function invalidate(profileId) {
	cache.delete(profileId);
}

module.exports = { getPriority, invalidate, CARDS };
