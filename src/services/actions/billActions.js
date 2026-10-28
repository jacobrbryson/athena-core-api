/**
 * Bill scan actions — record_vehicle_bill and record_property_tax_bill.
 *
 * Added on the owner's explicit authorization of 2026-10-28 ("the specific new
 * action kinds this feature needs … each requiring my approval every time,
 * never eligible for a standing approval, with normalize() as narrow as
 * possible"). Nothing else in actions/ was widened.
 *
 * How they stay narrow:
 *  - They exist only for the bill scanner. normalize() refuses unless the
 *    caller is code that passed `ctx.billScan` (services/billScan.js builds the
 *    proposal itself after validating a photographed bill). A model naming one
 *    in `proposed_action` goes through the same normalize() with no such
 *    context and is refused.
 *  - `standing: false`: a standing approval can never skip the person's tap.
 *  - The model supplies no event text. The calendar events are DERIVED here,
 *    from the validated due date and the vehicle's or property's own name, then
 *    run through create_calendar_event's own normalize() — they can never be
 *    something that action would refuse (all-day, primary calendar, no guests).
 *  - Every id is looked up in the caller's own rows; a uuid is never trusted.
 *  - One approval claims the bill's fingerprint, so a second card for the same
 *    bill (or a double tap) cannot add a second event.
 *
 * The approval itself is the athena_action row plus its audit entries, like
 * every action; the bill's own log row (athena_bill_scan) links to it.
 */

const googleCalendar = require("../connectors/googleCalendar");
const credentials = require("../credentials");
const records = require("../billRecords");

const registry = () => require("./registry");

const DAY = 86_400_000;
const invalid = (message) => registry().invalid(message);

function str(value, max) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : null;
}

function money(value, label) {
	if (value === undefined || value === null || value === "") return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) throw invalid(`${label} isn't an amount I can use`);
	return Math.round(n * 100) / 100;
}

/** A date within a believable distance of today: a bill is for last year's overdue or the next couple of years' due. */
function dateWithin(value, label, { past = 400, future = 800 } = {}) {
	const v = str(value, 10);
	if (!records.isDay(v)) throw invalid(`${label} must be a date (YYYY-MM-DD)`);
	const days = (Date.parse(`${v}T00:00:00Z`) - Date.parse(`${records.todayUtc()}T00:00:00Z`)) / DAY;
	if (days < -past || days > future) throw invalid(`${label} is too far from today to be right`);
	return v;
}

async function calendarLinked(profileId) {
	const rows = await credentials.list(profileId);
	return (rows || []).some((r) => r.status === "active" && r.provider === "google_calendar");
}

/** Run each drafted event through the calendar action's own normalize(). */
function vouchedEvents(drafts) {
	const calendar = registry().get("create_calendar_event");
	return drafts.map((d) => calendar.normalize(d));
}

async function calendarPart(raw, ctx, { paid, title, dueOns, note }) {
	const wanted = raw.calendar === true && !paid;
	if (!wanted) return { calendar: false, remind_days: 0, events: [] };
	if (!(await calendarLinked(ctx.profileId))) throw invalid("Google Calendar isn't connected");
	const remindDays = Number.isInteger(raw.remind_days) && raw.remind_days >= 0 && raw.remind_days <= 60 ? raw.remind_days : 14;
	const today = records.todayUtc();
	const drafts = dueOns.flatMap((dueOn, n) =>
		records.eventDrafts({ title: title(dueOn), dueOn, remindDays: n === 0 ? remindDays : 0, today, note })
	);
	return { calendar: true, remind_days: remindDays, events: vouchedEvents(drafts.slice(0, 6)) };
}

function requireScanner(ctx) {
	if (ctx.billScan !== true) {
		throw invalid("Bills are recorded only from a photo the person shows me — ask them to show me the bill");
	}
}

function billRef(raw) {
	const fp = str(raw.bill_fp, 64);
	if (!/^[a-f0-9]{64}$/.test(fp || "")) throw invalid("That bill has no reference");
	return fp;
}

const eventCount = (events) => events.length;
const describeEvents = (p) =>
	p.events.length
		? ` and add ${eventCount(p.events)} all-day calendar event${p.events.length === 1 ? "" : "s"} (${p.events.map((e) => records.shortDay(e.start)).join(", ")})`
		: p.calendar === false && !p.paid ? " (no calendar event: Google Calendar isn't connected)" : "";

/** Undo events already written when the record update that goes with them fails. */
async function withdraw(profileId, refs) {
	for (const ref of refs) await googleCalendar.deleteEvent(profileId, { event_id: ref }).catch(() => {});
}

async function run(profileId, p, ctx, apply) {
	await records.claim(profileId, p.bill_fp);
	const refs = [];
	try {
		for (const event of p.events) refs.push((await googleCalendar.createEvent(profileId, event)).ref);
		const applied = await apply(profileId, p);
		await records.noteApplied(profileId, p.bill_fp, { actionUuid: ctx.actionUuid, calendarRefs: refs });
		return { ref: refs.join(",") || applied.tax || applied.vehicle || applied.property, detail: { events: refs.length, ...applied } };
	} catch (err) {
		await withdraw(profileId, refs);
		await records.release(profileId, p.bill_fp);
		throw err;
	}
}

module.exports = [
	{
		id: "record_vehicle_bill",
		label: "Record a vehicle registration bill",
		provider: null,
		consentType: "action_authority",
		// The date can be set back on the vehicle and the events deleted from the calendar by the person.
		reversible: true,
		standing: false,
		describe:
			"Created only by the bill scanner when the person photographs a vehicle registration bill or receipt. " +
			"Never propose this yourself from conversation: it is refused unless it came from the scanner.",
		params: { bill_fp: "Set by the bill scanner only. Never fill this in." },

		async normalize(raw = {}, ctx = {}) {
			requireScanner(ctx);
			const bill_fp = billRef(raw);
			const vehicle = await records.ownVehicle(ctx.profileId, raw.vehicle_uuid);
			if (!vehicle) throw invalid("That vehicle isn't on your list");
			const paid = raw.paid === true;
			const registration_due = dateWithin(raw.registration_due, "The registration date");
			const out = {
				bill_fp, vehicle_uuid: vehicle.uuid, vehicle_name: vehicle.name.slice(0, 100), registration_due, previous_due: vehicle.registration_due || null,
				paid, ...(paid ? { paid_on: dateWithin(raw.paid_on || records.todayUtc(), "The date paid", { past: 400, future: 1 }) } : {}),
				...(money(raw.amount, "The amount") ? { amount: money(raw.amount, "The amount") } : {}),
				...(str(raw.payee, 120) ? { payee: str(raw.payee, 120) } : {}),
			};
			if (raw.tax) {
				const amount = money(raw.tax.amount, "The tax amount");
				if (!amount) throw invalid("The tax needs an amount");
				const year = Number(raw.tax.tax_year);
				if (!Number.isInteger(year) || year < 1990 || year > new Date().getUTCFullYear() + 2) throw invalid("The tax year isn't one I can use");
				out.tax = {
					amount, tax_year: year, due_on: dateWithin(raw.tax.due_on, "The tax due date"),
					...(str(raw.tax.jurisdiction, 160) ? { jurisdiction: str(raw.tax.jurisdiction, 160) } : {}),
				};
			}
			const note = ["Added by Athena from a scanned bill.", out.amount ? `Amount ${records.money(out.amount)}.` : null, out.payee ? `Pay: ${out.payee}.` : null].filter(Boolean).join(" ");
			return {
				...out,
				...(await calendarPart(raw, ctx, {
					paid, dueOns: [registration_due], note,
					title: (d) => `Renew ${vehicle.name.slice(0, 80)} registration (due ${records.shortDay(d)})`,
				})),
			};
		},

		summarize(p) {
			const amount = p.amount ? ` (${records.money(p.amount)}${p.payee ? ` to ${p.payee}` : ""})` : "";
			if (p.paid) {
				return `Mark ${p.vehicle_name}'s registration renewed${amount}: next due ${records.shortDay(p.registration_due, { year: true })}${p.tax ? `, and mark its ${records.money(p.tax.amount)} vehicle tax paid` : ""}`.slice(0, 500);
			}
			return `Record ${p.vehicle_name}'s registration bill${amount}: set its registration date to ${records.shortDay(p.registration_due, { year: true })}${p.tax ? `, record the ${records.money(p.tax.amount)} vehicle tax billed with it` : ""}${describeEvents(p)}`.slice(0, 500);
		},

		// The same bill. Never mind the wording; the fingerprint is the bill.
		sameAs: (a, b) => a.bill_fp === b.bill_fp,

		execute: (profileId, params, ctx) => run(profileId, params, ctx, records.applyVehicle),
	},

	{
		id: "record_vehicle_notice",
		label: "Save a vehicle notice",
		provider: null,
		consentType: "action_authority",
		// Adds one line to the vehicle's notes, which the person can edit or delete there.
		reversible: true,
		standing: false,
		describe:
			"Created only by the bill scanner when the person shows a letter about one of their vehicles (a warranty extension, a recall letter). " +
			"Never propose this yourself from conversation: it is refused unless it came from the scanner.",
		params: { bill_fp: "Set by the bill scanner only. Never fill this in." },

		async normalize(raw = {}, ctx = {}) {
			requireScanner(ctx);
			const bill_fp = billRef(raw);
			const vehicle = await records.ownVehicle(ctx.profileId, raw.vehicle_uuid);
			if (!vehicle) throw invalid("That vehicle isn't on your list");
			const title = str(raw.notice_title, 120);
			if (!title) throw invalid("A notice needs a title");
			const summary = str(raw.notice_summary, 600);
			const coverage = str(raw.coverage, 200);
			const notice_on = dateWithin(raw.notice_on || records.todayUtc(), "The notice date", { past: 400, future: 1 });
			// What is stored is built here, from the validated parts: one dated line.
			const note_line = `[${notice_on}] ${title}.${coverage ? ` Coverage: ${coverage}.` : ""}${summary ? ` ${summary}` : ""}`.replace(/\s+/g, " ").slice(0, 900);
			if ((vehicle.notes || "").length + note_line.length + 1 > records.NOTES_MAX) throw invalid("That vehicle's notes are full");
			return { bill_fp, vehicle_uuid: vehicle.uuid, vehicle_name: vehicle.name.slice(0, 100), notice_title: title, ...(coverage ? { coverage } : {}), note_line, events: [] };
		},

		summarize(p) {
			return `Save this to ${p.vehicle_name}'s notes so I keep it in mind: ${p.note_line}`.slice(0, 500);
		},

		sameAs: (a, b) => a.bill_fp === b.bill_fp,

		execute: (profileId, params, ctx) => run(profileId, params, ctx, records.applyVehicleNotice),
	},

	{
		id: "record_property_tax_bill",
		label: "Record a property tax bill",
		provider: null,
		consentType: "action_authority",
		reversible: true,
		standing: false,
		describe:
			"Created only by the bill scanner when the person photographs a property tax bill or receipt. " +
			"Never propose this yourself from conversation: it is refused unless it came from the scanner.",
		params: { bill_fp: "Set by the bill scanner only. Never fill this in." },

		async normalize(raw = {}, ctx = {}) {
			requireScanner(ctx);
			const bill_fp = billRef(raw);
			const property = await records.ownProperty(ctx.profileId, raw.property_uuid);
			if (!property) throw invalid("That property isn't on your list");
			const jurisdiction = str(raw.jurisdiction, 160);
			if (!jurisdiction) throw invalid("A tax bill needs who it's owed to");
			const rawInstallments = Array.isArray(raw.installments) ? raw.installments : [];
			if (!rawInstallments.length) throw invalid("A tax bill needs at least one due date");
			if (rawInstallments.length > 6) throw invalid("That's more installments than I'll record from one bill");
			const seen = new Set();
			const installments = rawInstallments.map((i) => {
				const due_on = dateWithin(i?.due_on, "An installment's due date");
				if (seen.has(due_on)) throw invalid("Two installments share a due date");
				seen.add(due_on);
				return { label: str(i.label, 60) || "Due", due_on, ...(money(i.amount, "An installment's amount") ? { amount: money(i.amount, "An installment's amount") } : {}) };
			}).sort((a, b) => a.due_on.localeCompare(b.due_on));
			const paid = raw.paid === true;
			const year = raw.tax_year === undefined ? null : Number(raw.tax_year);
			if (year !== null && (!Number.isInteger(year) || year < 1990 || year > new Date().getUTCFullYear() + 2)) throw invalid("The tax year isn't one I can use");
			const out = {
				escrowed: raw.escrowed === true, bill_fp, property_uuid: property.uuid, property_name: property.name.slice(0, 100), jurisdiction, installments, paid,
				...(paid ? { paid_on: dateWithin(raw.paid_on || records.todayUtc(), "The date paid", { past: 400, future: 1 }) } : {}),
				...(year ? { tax_year: year } : {}),
				...(str(raw.parcel, 80) ? { parcel: str(raw.parcel, 80) } : {}),
				...(str(raw.account, 80) ? { account: str(raw.account, 80) } : {}),
				...(str(raw.address, 240) ? { address: str(raw.address, 240) } : {}),
				...(money(raw.amount, "The amount") ? { amount: money(raw.amount, "The amount") } : {}),
			};
			// Escrowed taxes are paid by the lender: no calendar event, whatever was asked.
			if (out.escrowed) raw = { ...raw, calendar: false };
			const note = ["Added by Athena from a scanned bill.", out.amount ? `Total ${records.money(out.amount)}.` : null, `Pay: ${jurisdiction}.`].filter(Boolean).join(" ");
			return {
				...out,
				// The next four payments still ahead; the first also gets the reminder.
				...(await calendarPart(raw, ctx, {
					paid, dueOns: installments.map((i) => i.due_on).filter((d) => d >= records.todayUtc()).slice(0, 4), note,
					title: (d) => {
						const i = installments.find((x) => x.due_on === d);
						return `${year ? `${year} ` : ""}property tax${installments.length > 1 ? ` (${i.label})` : ""} due — ${jurisdiction.slice(0, 60)} (due ${records.shortDay(d)})`;
					},
				})),
			};
		},

		summarize(p) {
			const amount = p.amount ? ` (${records.money(p.amount)})` : "";
			const dues = p.installments.map((i) => `${records.shortDay(i.due_on, { year: true })}${i.amount ? ` ${records.money(i.amount)}` : ""}`).join(", ");
			if (p.escrowed && !p.paid) return `Record the ${p.jurisdiction} property tax bill for ${p.property_name}${amount}: due ${dues}. Taxes are escrowed, so your mortgage company pays it — no calendar event, and it stays off the Home banner`.slice(0, 500);
			if (p.paid) return `Mark the ${p.jurisdiction} property tax payment${p.installments.length > 1 ? "s" : ""} (${dues}) paid on ${records.shortDay(p.paid_on, { year: true })}`.slice(0, 500);
			return `Record the ${p.jurisdiction} property tax bill for ${p.property_name}${amount}: due ${dues}${describeEvents(p)}`.slice(0, 500);
		},

		sameAs: (a, b) => a.bill_fp === b.bill_fp,

		execute: (profileId, params, ctx) => run(profileId, params, ctx, records.applyTax),
	},
];
