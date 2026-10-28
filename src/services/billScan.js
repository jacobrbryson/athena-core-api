const llm = require("./llm");
const records = require("./billRecords");
const credentials = require("./credentials");

/**
 * Read a bill from a photo and turn it into ONE proposal card.
 *
 * A vehicle registration renewal or a property tax bill is read by the
 * "vision" task (adults only), every field is validated in code, and Athena
 * proposes — never does — a single action (record_vehicle_bill /
 * record_property_tax_bill, services/actions/registry.js) that the person
 * approves with one tap: the calendar event(s), the record update and the
 * bill itself.
 *
 * What is never guessed:
 *  - a field the model was not sure of, or that fails validation here, is
 *    handed back as `uncertain` for the person to confirm or correct;
 *  - a bill that fits no vehicle, or more than one, or a tax bill that is not
 *    clearly their property, asks which;
 *  - dates are read from the bill. No state's rules are built in.
 *
 * The photo is never stored: the extracted fields are logged
 * (athena_bill_scan, migration 0102) and that is all. Same rule as foodScan.
 */

const MAX_IMAGE_BASE64 = 6 * 1024 * 1024;
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const REMIND_DAYS = 14;
const MAX_INSTALLMENTS = 6;
const DAY = 86_400_000;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------------------
// The vision read
// ---------------------------------------------------------------------------

/** model field name -> [document key, how to validate, max length] */
const FIELDS = {
	payee: ["payee", "text", 120],
	jurisdiction: ["jurisdiction", "text", 160],
	plate: ["plate", "plate"],
	vin: ["vin", "vin"],
	state: ["state", "state"],
	vehicle_description: ["vehicleDescription", "text", 120],
	parcel: ["parcel", "text", 80],
	account: ["account", "text", 80],
	tax_year: ["taxYear", "year"],
	address: ["address", "text", 240],
	registration_expires: ["dueDate", "date"],
	amount_due: ["amountDue", "money"],
	tax_amount: ["taxAmount", "money"],
	registration_fee: ["registrationFee", "money"],
	paid_on: ["paidOn", "date"],
	past_due_after: ["pastDueAfter", "date"],
	notice_title: ["noticeTitle", "text", 120],
	notice_summary: ["noticeSummary", "text", 600],
	coverage_terms: ["coverage", "text", 200],
	escrowed: ["escrowed", "text", 10],
};

/**
 * Every field is required under a response schema (an unrequired one is
 * dropped — see foodScan SCAN_SCHEMA), so the lists carry "" for what the
 * bill doesn't say. Values stay strings; code parses them.
 */
const BILL_SCHEMA = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["vehicle_registration", "property_tax", "vehicle_notice", "other"] },
		status: { type: "string", enum: ["bill", "receipt"] },
		fields: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string", enum: Object.keys(FIELDS) },
					value: { type: "string" },
					confidence: { type: "string", enum: ["high", "medium", "low"] },
				},
				required: ["name", "value", "confidence"],
			},
		},
		installments: {
			type: "array",
			items: {
				type: "object",
				properties: {
					label: { type: "string" },
					due_date: { type: "string" },
					amount: { type: "string" },
					confidence: { type: "string", enum: ["high", "medium", "low"] },
				},
				required: ["label", "due_date", "amount", "confidence"],
			},
		},
		note: { type: "string" },
	},
	required: ["kind", "status", "fields", "installments"],
};

function checkRead(d) {
	if (!["vehicle_registration", "property_tax", "vehicle_notice", "other"].includes(d?.kind)) return "missing kind";
	if (!Array.isArray(d.fields) || !Array.isArray(d.installments)) return "missing fields";
	return null;
}

async function readBill({ imageBase64, mimeType, hint }) {
	const prompt = `This photo may be a bill or receipt that a person wants to keep track of.
Decide what it is:
- "vehicle_registration": a vehicle registration renewal notice, tag/plate renewal, or the receipt for one. In some places the vehicle property tax is billed with the registration; if so it is still this kind, and tax_amount is the tax part.
- "property_tax": a real-estate / property tax bill, or the receipt for one.
- "vehicle_notice": a letter or notice about a specific vehicle that is not a payment: a manufacturer warranty extension, a safety recall or service-campaign letter, an insurance or inspection notice. It is identified by a VIN or plate. Use notice_title (what it is, 3-10 words), notice_summary (2-4 plain sentences: what it says, what is covered, what to do) and coverage_terms (e.g. "10 years / 120,000 miles") when it states a duration or limit. Do not invent a due date for it.
- "other": anything else (including any other bill, a menu, a document with no payment due and no vehicle). Return empty lists.
status: "receipt" only if it shows the amount was PAID (paid stamp, receipt, "payment received"); otherwise "bill".

Read ONLY what is printed. Never infer, never fill a gap from what is usual for a state or county — if the bill doesn't print it, leave value "" and confidence "low". For every field give a value exactly as printed (dates as YYYY-MM-DD, amounts as plain numbers like 214.50) and a confidence: "high" only when the text is clear and unambiguous; "medium" if partly obscured or you had to choose between readings; "low" if you are guessing. If a date could be read day-first or month-first, use "low".
fields (use each name at most once, only those that apply):
  payee (who is paid), jurisdiction (the state, county or city levying it),
  plate, vin (full, or the last digits if only those are printed), state (two-letter), vehicle_description (year/make/model/color as printed),
  parcel (parcel / PIN / tax map number), account (account or bill number), tax_year, address (the property or mailing address),
  registration_expires (the date the registration expires or the renewal is due),
  amount_due (the total to pay), tax_amount (the vehicle tax part, if listed apart), registration_fee (the registration fee part, if listed apart),
  notice_title, notice_summary, coverage_terms (only for a vehicle_notice),
  paid_on (only on a receipt: the date paid),
  past_due_after (a "past due after" / "delinquent after" / "interest begins" date, when it is later than the printed due date),
  escrowed ("yes" or "no" — only if the bill has a "taxes escrowed" box or says a mortgage company pays it).
installments: every payment the bill asks for, each with its own due date and amount (label e.g. "1st half", "Due"). A bill with a single due date has one. A receipt has none unless it states what it covered.
note: one short sentence on anything odd.
${hint ? `The person said: "${String(hint).slice(0, 200)}"` : ""}
Return ONLY JSON matching: ${JSON.stringify(BILL_SCHEMA)}`;
	const { data } = await llm.generateJson({
		task: "vision",
		audience: "adult",
		schema: BILL_SCHEMA,
		contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
		check: checkRead,
	});
	return data;
}

// ---------------------------------------------------------------------------
// Validation in code
// ---------------------------------------------------------------------------

function parseDay(raw, today) {
	const v = String(raw ?? "").trim();
	if (!v) return { value: null };
	if (!records.isDay(v)) return { value: null, problem: "isn't a full date I can use" };
	const days = (Date.parse(`${v}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY;
	if (days < -400 || days > 800) return { value: null, problem: "is too far from today to be right" };
	return { value: v };
}

function parseMoney(raw) {
	const v = String(raw ?? "").replace(/[$,\s]/g, "");
	if (!v) return { value: null };
	if (!/^\d+(\.\d{1,2})?$/.test(v)) return { value: null, problem: "isn't an amount I can use" };
	const n = Math.round(Number(v) * 100) / 100;
	return n > 0 && n <= 10_000_000 ? { value: n } : { value: null, problem: "is out of range" };
}

const VIN_VALUES = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** A full VIN (check digit tested — a mismatch is a likely misread, not a refusal), or the last digits when that's all there is. */
function parseVin(raw) {
	const v = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (!v) return { value: null };
	if (v.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/.test(v)) {
		const sum = [...v].reduce((n, c, i) => n + (/\d/.test(c) ? Number(c) : VIN_VALUES[c]) * VIN_WEIGHTS[i], 0);
		const check = sum % 11 === 10 ? "X" : String(sum % 11);
		// Non-North-American VINs needn't carry a check digit: lower the confidence, keep the value.
		return check === v[8] ? { value: v } : { value: v, problem: "has a check digit that doesn't add up — one character may be misread" };
	}
	if (v.length >= 4 && v.length < 17 && /^[A-HJ-NPR-Z0-9]+$/.test(v)) return { value: null, last: v };
	return { value: null, problem: "isn't a VIN I can use" };
}

function parseValue(spec, raw, today) {
	const [, type, max] = spec;
	const text = String(raw ?? "").trim();
	if (!text) return { value: null };
	switch (type) {
		case "date": return parseDay(text, today);
		case "money": return parseMoney(text);
		case "vin": return parseVin(text);
		case "plate": {
			const v = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
			return /^[A-Z0-9]{2,8}$/.test(v) ? { value: v } : { value: null, problem: "isn't a plate I can use" };
		}
		case "state": return /^[A-Za-z]{2}$/.test(text) ? { value: text.toUpperCase() } : { value: null, problem: "isn't a two-letter state" };
		case "year": {
			const n = Number(text);
			const thisYear = Number(today.slice(0, 4));
			return Number.isInteger(n) && n >= thisYear - 3 && n <= thisYear + 1 ? { value: n } : { value: null, problem: "isn't a plausible tax year" };
		}
		default: return { value: text.slice(0, max) };
	}
}

const LABELS = {
	payee: "who it's paid to", jurisdiction: "the jurisdiction", plate: "the plate", vin: "the VIN", state: "the state", vehicleDescription: "the vehicle",
	parcel: "the parcel number", account: "the account number", taxYear: "the tax year", address: "the address", dueDate: "the due date",
	amountDue: "the amount due", taxAmount: "the tax amount", registrationFee: "the registration fee", paidOn: "the date paid", pastDueAfter: "the date it becomes past due", noticeTitle: "what the notice is", noticeSummary: "what the notice says", coverage: "the coverage terms", escrowed: "whether the taxes are escrowed",
};

/**
 * Entries -> the document. `entries` is { modelFieldName: { value, confidence } }
 * and `rawInstallments` [{ label, due_date, amount, confidence }]. Anything that
 * fails validation, or that the reader wasn't sure of, lands in `uncertain` with
 * its value kept for the person to see; an invalid value is not used.
 */
function buildDocument({ kind, paid, entries, rawInstallments, today }) {
	const doc = { kind, paid: !!paid, installments: [] };
	const uncertain = [];
	for (const [name, spec] of Object.entries(FIELDS)) {
		const entry = entries[name];
		const key = spec[0];
		if (!entry || !String(entry.value ?? "").trim()) continue;
		const parsed = parseValue(spec, entry.value, today);
		if (parsed.last) doc.vinLast = parsed.last;
		// A value that parsed is kept — even a VIN whose check digit failed, so the person sees it to correct it.
		else if (parsed.value !== null && parsed.value !== undefined) doc[key] = parsed.value;
		if (parsed.problem || entry.confidence !== "high") {
			uncertain.push({ field: key, label: LABELS[key], value: String(entry.value).slice(0, 120), reason: parsed.problem ? `${LABELS[key]} ${parsed.problem}` : `I wasn't sure of ${LABELS[key]}` });
		}
	}
	(rawInstallments || []).slice(0, MAX_INSTALLMENTS).forEach((i, n) => {
		const due = parseDay(i.due_date, today);
		const amount = parseMoney(i.amount);
		const label = String(i.label || "").trim().slice(0, 60) || (n === 0 ? "Due" : `Payment ${n + 1}`);
		if (due.value === null) {
			if (String(i.due_date || "").trim()) uncertain.push({ field: `installments.${n}.dueOn`, label: `the due date of "${label}"`, value: String(i.due_date).slice(0, 40), reason: `The due date of "${label}" ${due.problem}` });
			return;
		}
		doc.installments.push({ label, dueOn: due.value, amount: amount.value });
		if (amount.problem) uncertain.push({ field: `installments.${doc.installments.length - 1}.amount`, label: `the amount of "${label}"`, value: String(i.amount).slice(0, 40), reason: `The amount of "${label}" ${amount.problem}` });
		if (i.confidence && i.confidence !== "high") uncertain.push({ field: `installments.${doc.installments.length - 1}.dueOn`, label: `"${label}"`, value: `${due.value}${amount.value ? ` · $${amount.value}` : ""}`, reason: `I wasn't sure of the date or amount of "${label}"` });
	});
	doc.uncertain = uncertain;
	return doc;
}

/** The shape the app edits and sends back. Strings only for what the person types. */
function toClient(doc) {
	const { uncertain, ...rest } = doc;
	return { ...rest, uncertain };
}

/** A document the person confirmed or corrected -> the same document, every value validated again and trusted as theirs. */
function fromClient(input, today) {
	if (!input || typeof input !== "object") throw bad("Send the bill's details.");
	if (!["vehicle_registration", "property_tax", "vehicle_notice"].includes(input.kind)) throw bad("That isn't a bill or vehicle notice I can read.");
	const entries = {};
	for (const [name, spec] of Object.entries(FIELDS)) {
		const key = spec[0];
		const raw = name === "vin" ? input.vin || input.vinLast : input[key];
		if (raw !== undefined && raw !== null && String(raw).trim() !== "") entries[name] = { value: String(raw), confidence: "high" };
	}
	const rawInstallments = (Array.isArray(input.installments) ? input.installments : []).slice(0, MAX_INSTALLMENTS)
		.map((i) => ({ label: i?.label, due_date: i?.dueOn, amount: i?.amount == null ? "" : String(i.amount), confidence: "high" }));
	// Confirmed, so `uncertain` is not consulted; a value that doesn't parse is simply not used.
	return buildDocument({ kind: input.kind, paid: !!input.paid, entries, rawInstallments, today });
}

// ---------------------------------------------------------------------------
// Matching: which vehicle, which property
// ---------------------------------------------------------------------------

const words = (text) => new Set(records.loose(text).split(" ").filter(Boolean));
const carOf = (v) => [v.year, v.color, v.make, v.model].filter(Boolean).join(" ");
const vehicleLabel = (v) => (carOf(v) && records.loose(carOf(v)) !== records.loose(v.name) ? `${v.name} — ${carOf(v)}` : v.name);

function scoreVehicle(v, d) {
	const plate = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
	let score = 0;
	const why = [];
	if (d.vin && v.vin && d.vin === v.vin) { score = 100; why.push("VIN"); }
	else if (d.plate && v.plate && plate(d.plate) === plate(v.plate)) { score = 90; why.push("plate"); }
	else if (d.vinLast && v.vin && v.vin.endsWith(d.vinLast)) { score = 80; why.push("last VIN digits"); }
	else if (d.vehicleDescription) {
		const have = words(d.vehicleDescription);
		const n = (s) => [...words(s)].filter(Boolean);
		const make = n(v.make).length && n(v.make).every((w) => have.has(w));
		const model = n(v.model).length && n(v.model).every((w) => have.has(w));
		const year = v.year && have.has(String(v.year));
		const color = n(v.color).length && n(v.color).every((w) => have.has(w));
		const hits = [make, model, year, color].filter(Boolean).length;
		if ((make || model) && hits >= 2) { score = 40 + 10 * hits; why.push("description"); }
	}
	// A plate or VIN on the bill that contradicts this vehicle's own is not a match, whatever else fits.
	if (score && score < 90 && d.plate && v.plate && plate(d.plate) !== plate(v.plate)) score = Math.min(score, 30);
	if (score && d.vin && v.vin && d.vin !== v.vin) score = Math.min(score, 30);
	return { score, why };
}

/** { vehicle } when exactly one fits, else { ask: [...] } — never a guess. */
function matchVehicle(all, d) {
	if (!all.length) return { none: true };
	const scored = all.map((v) => ({ v, ...scoreVehicle(v, d) }));
	const strong = scored.filter((s) => s.score >= 80);
	if (strong.length === 1) return { vehicle: strong[0].v, why: strong[0].why };
	if (!strong.length) {
		const any = scored.filter((s) => s.score >= 40);
		const anyHit = scored.filter((s) => s.score > 0);
		if (any.length === 1 && anyHit.length === 1) return { vehicle: any[0].v, why: any[0].why };
	}
	const ranked = (strong.length > 1 ? strong : scored.filter((s) => s.score > 0).length ? scored.filter((s) => s.score > 0) : scored).sort((a, b) => b.score - a.score);
	return { ask: ranked.map((s) => ({ uuid: s.v.uuid, label: vehicleLabel(s.v), why: s.why.join(", ") })) };
}

function matchProperty(all, d, parcelProperty) {
	if (!all.length) return { none: true };
	if (parcelProperty) {
		const hit = all.find((p) => p.uuid === parcelProperty);
		if (hit) return { property: hit, why: ["parcel"] };
	}
	const bill = records.loose(d.address).split(" ").filter(Boolean);
	const hits = all.filter((p) => {
		const mine = records.loose(p.address).split(" ").filter(Boolean);
		if (!bill.length || !mine.length || bill[0] !== mine[0] || !/^\d/.test(bill[0])) return false;
		const shared = bill.filter((w) => mine.includes(w)).length;
		return shared / Math.min(bill.length, mine.length) >= 0.6;
	});
	if (hits.length === 1) return { property: hits[0], why: ["address"] };
	return { ask: all.map((p) => ({ uuid: p.uuid, label: p.address ? `${p.name} — ${p.address}` : p.name, why: "" })) };
}

// ---------------------------------------------------------------------------
// From a document to a proposal
// ---------------------------------------------------------------------------

const validToday = (v) => {
	const server = records.todayUtc();
	// The person's own date (their timezone), within a day of the server's.
	return typeof v === "string" && records.isDay(v) && Math.abs(Date.parse(`${v}T00:00:00Z`) - Date.parse(`${server}T00:00:00Z`)) <= 2 * DAY ? v : server;
};

async function calendarReady(profileId) {
	try {
		const rows = await credentials.list(profileId);
		return (rows || []).some((r) => r.status === "active" && r.provider === "google_calendar");
	} catch {
		return false;
	}
}

function needsInput(doc, extra = {}) {
	return { status: "needs_input", document: toClient(doc), ...extra };
}

/**
 * The tail shared by a fresh scan and a corrected one: check what's missing,
 * match to a record, and propose. `choice` is { vehicleUuid, propertyUuid,
 * installmentUuid, confirmed } — a uuid the person picked is still looked up in
 * their own rows.
 */
async function finish(profileId, doc, { choice = {}, confirmed = false, scanUuid = null, today, actions }) {
	const fieldsForLog = toClient(doc);
	if (!confirmed && doc.uncertain.length) {
		return needsInput(doc, { note: "I read this, but I wasn't sure of everything. Check the highlighted parts — nothing is saved or added to your calendar until you've approved it." });
	}
	if (doc.kind === "vehicle_notice") return vehicleNotice(profileId, doc, { choice, scanUuid, today, actions, fieldsForLog });
	return doc.kind === "vehicle_registration"
		? vehicleBill(profileId, doc, { choice, scanUuid, today, actions, fieldsForLog })
		: taxBill(profileId, doc, { choice, scanUuid, today, actions, fieldsForLog });
}

const dueOf = (doc) => doc.dueDate || doc.installments[0]?.dueOn || null;

async function propose(profileId, actions, actionId, params, { fp, scanUuid, docKind, fieldsForLog, summarySubject }) {
	const bound = await records.bindFingerprint(profileId, scanUuid, fp, docKind, fieldsForLog);
	if (bound.state === "applied") {
		return { status: "already_recorded", document: fieldsForLog, note: `I've already recorded this bill${bound.appliedOn ? ` (on ${bound.appliedOn})` : ""}${summarySubject ? ` for ${summarySubject}` : ""}, so I've changed nothing and added nothing to your calendar.` };
	}
	const out = await actions.attempt(profileId, null, { id: actionId, params: { ...params, bill_fp: fp }, rationale: "You showed me this bill." }, { billScan: true });
	if (out.rejected && !out.proposal) {
		if (out.rejected.stage === "unavailable") {
			return { status: "unavailable", document: fieldsForLog, note: "I can read bills, but I can only propose changes once you've turned on “Let Athena propose changes” (⋯ menu → Actions)." };
		}
		throw bad(out.rejected.reason || "I couldn't put that together.", 422);
	}
	const card = out.proposal || out.repeat;
	if (!card) throw bad("I couldn't put that together.", 422);
	await records.linkAction(profileId, fp, card.uuid);
	return { status: "proposed", document: fieldsForLog, proposal: card, repeated: !out.proposal };
}

async function vehicleBill(profileId, doc, { choice, scanUuid, today, actions, fieldsForLog }) {
	const all = await records.vehicles(profileId);
	if (!all.length) return needsInput(doc, { note: "You don't have any vehicles saved yet. Add the vehicle under Property → Vehicles first, then show me the bill again." });
	let vehicle = choice.vehicleUuid ? all.find((v) => v.uuid === choice.vehicleUuid) : null;
	if (choice.vehicleUuid && !vehicle) throw bad("That vehicle is no longer on your list.", 404);
	if (!vehicle) {
		const m = matchVehicle(all, doc);
		if (!m.vehicle) return needsInput(doc, { candidates: { type: "vehicle", items: m.ask }, note: "Which vehicle is this for?" });
		vehicle = m.vehicle;
	}
	let dueOn = dueOf(doc);
	if (doc.paid) {
		// A receipt rolls the date: the new expiry if the receipt prints one, else a year after the old one — the "Renewed?" button's rule.
		if (!(doc.dueDate && doc.dueDate > today)) dueOn = vehicle.registration_due ? records.yearAfter(vehicle.registration_due) : null;
		else dueOn = doc.dueDate;
		if (!dueOn) return needsInput(doc, { missing: [{ field: "dueDate", label: "the new registration expiry date" }], note: `This looks like a receipt, but ${vehicle.name} has no registration date to move on. What is the new expiry date?` });
	} else if (!dueOn) {
		return needsInput(doc, { missing: [{ field: "dueDate", label: "the due date" }], note: "I couldn't find a due date on this. What is it?" });
	}
	// A receipt belongs to the bill it paid: the tax year is the year of the date it replaces, and it was due then.
	const yearBasis = doc.paid ? vehicle.registration_due || dueOn : dueOn;
	const taxPart = doc.taxAmount ? { amount: doc.taxAmount, jurisdiction: doc.jurisdiction || doc.payee || null, tax_year: doc.taxYear || Number(yearBasis.slice(0, 4)), due_on: doc.paid ? (doc.paidOn || today) : dueOn } : null;
	const calendar = !doc.paid && (await calendarReady(profileId));
	const params = {
		vehicle_uuid: vehicle.uuid, registration_due: dueOn, paid: doc.paid, paid_on: doc.paid ? (doc.paidOn || today) : undefined,
		amount: doc.amountDue ?? undefined, payee: doc.payee || doc.jurisdiction || undefined, ...(taxPart ? { tax: taxPart } : {}),
		calendar, remind_days: calendar ? REMIND_DAYS : 0,
	};
	const fp = records.fingerprint(["vehicle", vehicle.uuid, doc.paid, dueOn, doc.amountDue ?? null]);
	const res = await propose(profileId, actions, "record_vehicle_bill", params, { fp, scanUuid, docKind: doc.kind, fieldsForLog, summarySubject: vehicle.name });
	return { ...res, target: { type: "vehicle", uuid: vehicle.uuid, label: vehicleLabel(vehicle) } };
}

/**
 * A letter about one vehicle that asks for no payment (a warranty extension, a recall
 * letter): saved to the vehicle's notes, which she reads in conversation. The vehicle is
 * matched like any bill's — by VIN, plate or description — and asked about when unclear.
 */
async function vehicleNotice(profileId, doc, { choice, scanUuid, today, actions, fieldsForLog }) {
	const all = await records.vehicles(profileId);
	if (!all.length) return needsInput(doc, { note: "You don't have any vehicles saved yet. Add the vehicle under Property → Vehicles first, then show me the letter again." });
	let vehicle = choice.vehicleUuid ? all.find((v) => v.uuid === choice.vehicleUuid) : null;
	if (choice.vehicleUuid && !vehicle) throw bad("That vehicle is no longer on your list.", 404);
	if (!vehicle) {
		const m = matchVehicle(all, doc);
		if (!m.vehicle) return needsInput(doc, { candidates: { type: "vehicle", items: m.ask }, note: "Which vehicle is this letter about?" });
		vehicle = m.vehicle;
	}
	if (!doc.noticeTitle) return needsInput(doc, { missing: [{ field: "noticeTitle", label: "what this notice is" }], note: "What should I call this notice?" });
	const params = {
		vehicle_uuid: vehicle.uuid, notice_title: doc.noticeTitle, notice_on: today,
		...(doc.noticeSummary ? { notice_summary: doc.noticeSummary } : {}), ...(doc.coverage ? { coverage: doc.coverage } : {}),
	};
	// The wording varies between reads of the same letter, so identity is the vehicle plus the title's main words.
	const key = [...new Set(records.loose(doc.noticeTitle).split(" ").filter((w) => w.length > 3))].sort().slice(0, 4);
	const fp = records.fingerprint(["notice", vehicle.uuid, key]);
	const res = await propose(profileId, actions, "record_vehicle_notice", params, { fp, scanUuid, docKind: doc.kind, fieldsForLog, summarySubject: vehicle.name });
	return { ...res, target: { type: "vehicle", uuid: vehicle.uuid, label: vehicleLabel(vehicle) } };
}

async function taxBill(profileId, doc, { choice, scanUuid, today, actions, fieldsForLog }) {
	const props = await records.properties(profileId);
	if (!props.length) return needsInput(doc, { note: "You haven't added your property yet. Add it from Property → Overview first, then show me the bill again." });
	let property = choice.propertyUuid ? props.find((p) => p.uuid === choice.propertyUuid) : null;
	if (choice.propertyUuid && !property) throw bad("That property is no longer on your list.", 404);
	if (!property) {
		const m = matchProperty(props, doc, await records.propertyForParcel(profileId, doc.parcel));
		if (!m.property) return needsInput(doc, { candidates: { type: "property", items: m.ask }, note: "Is this bill for one of these properties?" });
		property = m.property;
	}
	const jurisdiction = doc.jurisdiction || doc.payee;
	if (!jurisdiction) return needsInput(doc, { missing: [{ field: "jurisdiction", label: "who levies this tax (the county or city)" }], note: "Who is this tax owed to?" });
	const taxYear = doc.taxYear || null;
	let installments = doc.installments.map((i) => ({ label: i.label, due_on: i.dueOn, amount: i.amount ?? undefined }));
	if (!installments.length && doc.dueDate) installments = [{ label: "Due", due_on: doc.dueDate, amount: doc.amountDue ?? undefined }];
	// Some bills are "due" well before they are late (NC: due Sept 1, interest from Jan 6). A single payment then
	// carries the date that matters — when it turns past due — and says what the printed due date was.
	if (!doc.paid && doc.pastDueAfter && installments.length === 1 && installments[0].due_on < doc.pastDueAfter) {
		installments = [{ ...installments[0], label: `Late after (billed due ${records.shortDay(installments[0].due_on)})`, due_on: doc.pastDueAfter }];
	}
	const escrowed = /^y/i.test(doc.escrowed || "");

	if (doc.paid && !installments.length) {
		// A receipt that doesn't say which installment it paid: offer the unpaid ones on record.
		const key = records.taxKey({ kind: "property", jurisdiction, parcel: doc.parcel, account: doc.account, taxYear });
		const open = await records.unpaidFor(profileId, key);
		const picked = choice.installmentUuid ? open.find((i) => i.uuid === choice.installmentUuid) : null;
		if (picked) installments = [{ label: picked.label, due_on: picked.dueOn, amount: picked.amount ?? undefined }];
		else if (open.length === 1) installments = [{ label: open[0].label, due_on: open[0].dueOn, amount: open[0].amount ?? undefined }];
		else if (open.length > 1) return needsInput(doc, { installmentChoices: open, note: "Which payment does this receipt cover?" });
		else installments = [{ label: "Paid", due_on: doc.paidOn || today, amount: doc.amountDue ?? undefined }];
	}
	if (!installments.length) return needsInput(doc, { missing: [{ field: "dueDate", label: "the due date" }], note: "I couldn't find a due date on this. What is it?" });

	const amount = doc.amountDue ?? (installments.every((i) => i.amount != null) ? Math.round(installments.reduce((n, i) => n + i.amount, 0) * 100) / 100 : undefined);
	// Escrowed: the mortgage company pays it, so no reminder to pay (and nothing on the Home banner).
	const calendar = !doc.paid && !escrowed && (await calendarReady(profileId));
	const params = {
		escrowed,
		property_uuid: property.uuid, jurisdiction, parcel: doc.parcel || undefined, account: doc.account || undefined, tax_year: taxYear || undefined,
		amount, address: doc.address || undefined, installments, paid: doc.paid, paid_on: doc.paid ? (doc.paidOn || today) : undefined,
		calendar, remind_days: calendar ? REMIND_DAYS : 0,
	};
	const key = records.taxKey({ kind: "property", jurisdiction, parcel: doc.parcel, account: doc.account, taxYear });
	const fp = records.fingerprint(["tax", key, doc.paid, installments.map((i) => i.due_on), amount ?? null]);
	const res = await propose(profileId, actions, "record_property_tax_bill", params, { fp, scanUuid, docKind: doc.kind, fieldsForLog, summarySubject: property.name });
	return { ...res, target: { type: "property", uuid: property.uuid, label: property.name } };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function checkImage({ imageBase64, mimeType }) {
	if (typeof imageBase64 !== "string" || imageBase64.length < 100) throw bad("Take a photo of the bill.");
	if (imageBase64.length > MAX_IMAGE_BASE64) throw bad("Image is too large — downscale to about 1024px first");
	if (!MIME_TYPES.has(mimeType)) throw bad("Image must be JPEG, PNG, or WebP");
}

/** Read a photo. { status: 'not_a_bill' } for anything that isn't a vehicle registration or property tax bill. */
async function scan(profileId, body = {}) {
	checkImage(body);
	const today = validToday(body.today);
	const read = await readBill({ imageBase64: body.imageBase64, mimeType: body.mimeType, hint: body.hint });
	if (read.kind === "other") return { status: "not_a_bill" };
	const entries = {};
	for (const f of read.fields || []) if (FIELDS[f?.name] && !entries[f.name]) entries[f.name] = { value: f.value, confidence: f.confidence };
	const doc = buildDocument({ kind: read.kind, paid: read.status === "receipt", entries, rawInstallments: read.installments, today });
	const scanUuid = await records.logRead(profileId, read.kind, toClient(doc));
	console.info(`[billScan] profile ${profileId} read a ${read.kind}${doc.paid ? " receipt" : ""}: ${doc.uncertain.length} uncertain, ${doc.installments.length} installments`);
	const actions = require("./actions");
	return finish(profileId, doc, { scanUuid, today, actions });
}

/** The corrected or confirmed bill from the review sheet. */
async function review(profileId, body = {}) {
	const today = validToday(body.today);
	const doc = fromClient(body.document, today);
	const actions = require("./actions");
	return finish(profileId, doc, {
		choice: { vehicleUuid: body.vehicleUuid, propertyUuid: body.propertyUuid, installmentUuid: body.installmentUuid },
		confirmed: true, today, actions,
	});
}

/**
 * The chat photo path: a bill, or null. Never throws — when the read fails the
 * photo goes on to be described like any other, so a vision hiccup costs
 * nothing that was working before.
 */
async function scanIfBill(profileId, body = {}) {
	try {
		const res = await scan(profileId, body);
		return res.status === "not_a_bill" ? null : res;
	} catch (err) {
		console.warn("[billScan] chat photo check failed:", err.message);
		return null;
	}
}

module.exports = {
	scan, review, scanIfBill, REMIND_DAYS,
	_test: { parseDay, parseMoney, parseVin, buildDocument, fromClient, matchVehicle, matchProperty, scoreVehicle, readBill },
};
