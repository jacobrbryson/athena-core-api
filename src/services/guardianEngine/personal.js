/**
 * The personal half of the morning and evening reports (owner, 2026-11-10).
 *
 * The house half of a report is the household's; this half belongs to the one
 * adult it is sent to, read from their own links and rows only. Nobody sees
 * another adult's sleep, meetings or food log through the report.
 *
 * Every reader here is read-only and fails quiet: a source that can't be read
 * leaves its line out instead of failing the report, because the report's
 * first job is still the house.
 */
const pool = require("../../helpers/db");

const quiet = (p) => Promise.resolve(p).catch(() => null);

/** YYYY-MM-DD of `now` in the household's zone. */
function dayIn(now, timeZone) {
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((p) => [p.type, p.value]));
	return `${parts.year}-${parts.month}-${parts.day}`;
}

async function linked(profileId, provider) {
	const links = await require("../credentials").list(profileId);
	return links.some((l) => l.provider === provider && l.status === "active");
}

/** Last night's sleep and this morning's recovery — WHOOP, behind the person's health consent. */
async function sleepOf(profileId, now) {
	if (!(await linked(profileId, "whoop"))) return null;
	if (!(await require("../consent").hasConsentForProfile(profileId, "health_data"))) return null;
	const whoop = require("../connectors/whoop");
	const [recoveries, sleeps] = await Promise.all([quiet(whoop.listRecovery(profileId, { days: 2, limit: 3 })), quiet(whoop.listSleep(profileId, { days: 2, limit: 5 }))]);
	const recent = (iso) => iso && now - new Date(iso) < 18 * 3_600_000;
	const sleep = (sleeps || []).find((s) => !s.nap && recent(s.end));
	// A recovery belongs to the sleep it scored; fall back to the newest one dated today or yesterday.
	const recovery = (recoveries || []).find((r) => sleep && r.sleep_id != null && String(r.sleep_id) === String(sleep.id)) || (sleep ? (recoveries || [])[0] : null);
	const out = {
		asleepHours: sleep && Number.isFinite(sleep.hours_asleep) && sleep.hours_asleep > 0 ? sleep.hours_asleep : null,
		hrv: Number.isFinite(recovery?.hrv_ms) ? Math.round(recovery.hrv_ms) : null,
		rhr: Number.isFinite(recovery?.resting_heart_rate) ? Math.round(recovery.resting_heart_rate) : null,
	};
	return out.asleepHours || out.hrv || out.rhr ? out : null;
}

/** The first timed event still ahead today. Working-location blocks are already set aside by the reader. */
async function firstMeetingOf(profileId, now, timeZone) {
	if (!(await linked(profileId, "google_calendar"))) return null;
	const { events } = await require("../connectors/googleCalendar").collectEvents(profileId, { days: 1, maxResults: 25 });
	const today = dayIn(now, timeZone);
	const next = (events || [])
		.filter((e) => !e.allDay && e.start && new Date(e.start) >= now && dayIn(new Date(e.start), timeZone) === today && e.status !== "cancelled")
		.sort((a, b) => new Date(a.start) - new Date(b.start))[0];
	return next ? { at: new Date(next.start), title: next.title } : null;
}

const VEHICLE_DATES = { registration_due: "registration", inspection_due: "inspection", insurance_due: "insurance", service_due: "service" };

/** Everything due exactly today, across the person's own sources. Each source is optional. */
async function dueTodayOf(profileId, now, timeZone) {
	const today = dayIn(now, timeZone);
	const mmdd = today.slice(5);
	const sources = [
		// Jira issues with today's due date that aren't done.
		async () => {
			const { issues } = await require("../connectors/work").jira(profileId);
			return issues.filter((i) => i.due === today && i.statusCategory !== "done").map((i) => `${i.key} ${i.title}`);
		},
		// Vehicle registration, inspection, insurance and service dates.
		async () => {
			const cols = Object.keys(VEHICLE_DATES);
			const [rows] = await pool.query(
				`SELECT name, ${cols.map((c) => `DATE_FORMAT(${c}, '%Y-%m-%d') AS ${c}`).join(", ")} FROM athena_property_vehicle WHERE profile_id = ?`,
				[profileId]
			);
			return rows.flatMap((r) => cols.filter((c) => r[c] === today).map((c) => `${r.name || "Vehicle"} ${VEHICLE_DATES[c]}`));
		},
		// Unpaid tax installments.
		async () => {
			const taxes = await require("../billRecords").listTaxes(profileId);
			return taxes.flatMap((t) => t.installments.filter((i) => i.dueOn === today && !i.paidOn).map(() => `${t.vehicleName ? `${t.vehicleName} ` : ""}${t.kind === "vehicle" ? "vehicle" : "property"} tax payment`));
		},
		// Project steps due today that aren't finished.
		async () => {
			const [rows] = await pool.query(
				`SELECT s.title FROM athena_project_step s JOIN athena_project p ON p.id = s.project_id
				 WHERE p.profile_id = ? AND s.due_on = ? AND s.status NOT IN ('done', 'skipped') ORDER BY s.id LIMIT 5`,
				[profileId, today]
			);
			return rows.map((r) => r.title);
		},
		// Birthdays: the family's children and the people linked to a Google Contact.
		async () => {
			const { children = [], links = [] } = await require("../familyPeople").overview(profileId);
			const people = [...children.map((c) => ({ name: c.name, birthday: c.birthday })), ...links.filter((l) => l.card).map((l) => ({ name: l.name, birthday: l.card.birthday }))];
			const seen = new Set();
			return people
				.filter((p) => p.name && typeof p.birthday === "string" && p.birthday.slice(-5) === mmdd && !seen.has(p.name) && seen.add(p.name))
				.map((p) => `${p.name}'s birthday`);
		},
	];
	const lists = await Promise.all(sources.map((fn) => quiet(fn())));
	return lists.flatMap((l) => l || []).slice(0, 6);
}

/** The personal lines of the morning report for one adult. */
async function morning(profileId, { now = new Date(), timeZone }) {
	const [sleep, meeting, due] = await Promise.all([quiet(sleepOf(profileId, now)), quiet(firstMeetingOf(profileId, now, timeZone)), quiet(dueTodayOf(profileId, now, timeZone))]);
	return { sleep, meeting, due: due || [] };
}

/** Today's food log against the person's targets, for the evening report. Null when no targets are set. */
async function evening(profileId, { now = new Date(), timeZone }) {
	const healthPlan = require("../healthPlan");
	const targets = await healthPlan.targets(profileId);
	if (!targets) return null;
	const food = await healthPlan.nutrition(profileId, { today: dayIn(now, timeZone) });
	return { targets, totals: food.totals, logged: food.entries.length > 0 };
}

module.exports = { morning, evening, dayIn, _test: { sleepOf, firstMeetingOf, dueTodayOf } };
