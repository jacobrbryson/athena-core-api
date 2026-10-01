/**
 * Gmail inbox triage HTTP surface: list/scan the triage list, and propose the
 * actions that file a receipt, add-and-file a travel/school email, or dismiss
 * one from the list. Every handler acts on the caller's own profile via
 * requireAdultActor — this is an owner-only feature, same boundary as the
 * rest of the Companion dashboard.
 *
 * Proposing goes through services/actions exactly the way a chat reply's
 * proposed_action does (see services/actions/index.js's propose()) — the
 * panel just supplies `raw` directly instead of a model reply, with
 * sessionId null. Nothing here writes to Gmail or email_receipt itself; that
 * only happens once the person approves the proposal.
 */

const { requireAdultActor } = require("../helpers/actor");
const emailTriage = require("../services/emailTriage");
const actions = require("../services/actions");
const gmail = require("../services/connectors/gmail");
const emailDraft = require("../services/emailDraft");

/** Map a service error onto a status, defaulting to 500 rather than 400. */
function fail(res, err, fallbackMessage) {
	const status = Number.isInteger(err?.status) ? err.status : 500;
	if (status >= 500) console.error("[email]", err?.message);
	return res.status(status).json({
		success: false,
		code: err?.code || null,
		message: status >= 500 ? fallbackMessage : err.message || fallbackMessage,
	});
}

function parsedExtracted(row) {
	return typeof row.extracted === "string" ? JSON.parse(row.extracted) : row.extracted || {};
}

/** True when the extraction found a date to put on a calendar. */
function hasEventDate(extracted) {
	return extracted?.has_event !== false && typeof extracted?.start === "string" && !!extracted.start;
}

/** file_travel_or_school_email params for one row — shared by the single and bundle paths. */
function eventParams(row, extracted, overrides = {}) {
	return {
		email_triage_uuid: row.uuid,
		label: overrides.label ?? (row.category === "travel" ? "Travel" : "School"),
		title: overrides.title ?? extracted.title ?? row.subject,
		start: overrides.start ?? extracted.start,
		end: overrides.end ?? extracted.end,
		all_day: overrides.all_day ?? extracted.all_day ?? false,
		location: overrides.location ?? extracted.location,
		time_zone: overrides.time_zone,
	};
}

async function list(req, res) {
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const items = await emailTriage.list(actor.profileId, {
			status: req.query.status,
			category: req.query.category,
			cursor: req.query.cursor,
			limit: req.query.limit,
		});
		return res.json({ items });
	} catch (err) {
		return fail(res, err, "Failed to load your mail list");
	}
}

/**
 * The body isn't stored in email_triage — only what the extraction pass
 * needed lives at rest there — so it's read live from Gmail each time the
 * detail modal opens. A failure here (needs_reauth, the message was since
 * deleted in Gmail, ...) must not hide the rest of the detail the person
 * came here for, so it's reported alongside the row rather than failing it.
 */
async function detail(req, res) {
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const row = await emailTriage.getByUuid(actor.profileId, req.params.uuid);
		if (!row) return res.status(404).json({ success: false, message: "That email could not be found" });
		let body = null;
		let bodyError = null;
		try {
			const message = await gmail.getMessage(actor.profileId, row.gmail_message_id, { format: "full" });
			body = gmail.plainTextBody(message) || null;
		} catch (err) {
			bodyError = err.message || "Could not load the email body";
		}
		return res.json({ ...row, body, bodyError });
	} catch (err) {
		return fail(res, err, "Failed to load that email");
	}
}

/** The body of the "Scan more" button. */
async function scan(req, res) {
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		return res.json(await emailTriage.scanNext(actor.profileId, { max: req.body?.max }));
	} catch (err) {
		return fail(res, err, "Failed to scan your inbox");
	}
}

/** Propose the action for one triaged email, from its stored category. */
async function propose(req, res) {
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const row = await emailTriage.getByUuid(actor.profileId, req.params.uuid);
		if (!row) return res.status(404).json({ success: false, message: "That email could not be found" });
		if (row.category === "pending") {
			return res.status(409).json({ success: false, message: "Athena hasn't sorted this email yet — try again in a few minutes, or press Scan more." });
		}
		if (!["receipt", "travel", "school"].includes(row.category)) {
			return res.status(400).json({ success: false, message: "There's nothing to propose for this email — archive or dismiss it instead" });
		}
		const overrides = req.body?.overrides || {};
		const extracted = row.extracted || {};

		let raw;
		if (row.category === "receipt") {
			raw = {
				id: "file_receipt_email",
				params: {
					items: [
						{
							email_triage_uuid: row.uuid,
							label: overrides.label ?? "Receipts",
							merchant: overrides.merchant ?? extracted.merchant ?? null,
							category: overrides.category ?? extracted.category ?? null,
							amount: overrides.amount ?? extracted.amount ?? null,
							currency: overrides.currency ?? extracted.currency ?? "USD",
							purchased_at: overrides.purchased_at ?? extracted.purchased_at ?? null,
						},
					],
				},
			};
		} else {
			if (!overrides.start && extracted.has_event === false) {
				return res.status(400).json({
					success: false,
					message: "Athena didn't find a specific date on this email — add one yourself, or dismiss it.",
				});
			}
			raw = { id: "file_travel_or_school_email", params: eventParams(row, extracted, overrides) };
		}

		const proposed = await actions.propose(actor.profileId, null, raw);
		if (!proposed) {
			return res.status(422).json({
				success: false,
				message: "Athena couldn't propose that — check the details (and that Gmail/Calendar are still connected) and try again",
			});
		}
		return res.json({ success: true, action: proposed });
	} catch (err) {
		return fail(res, err, "Failed to propose that action");
	}
}

/** Propose one grouped filing action across several similar receipt emails. */
async function proposeGroup(req, res) {
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const uuids = Array.isArray(req.body?.email_triage_uuids) ? req.body.email_triage_uuids : [];
		if (!uuids.length) return res.status(400).json({ success: false, message: "Needs at least one email" });
		const rows = await emailTriage.getRowsByUuids(actor.profileId, uuids);
		if (!rows.length) return res.status(404).json({ success: false, message: "Those emails could not be found" });
		if (rows.some((r) => r.category !== "receipt")) {
			return res.status(400).json({ success: false, message: "Grouped filing only works for receipts right now" });
		}
		const overrides = req.body?.overrides || {};
		const items = rows.map((row) => {
			const extracted = parsedExtracted(row);
			return {
				email_triage_uuid: row.uuid,
				label: overrides.label ?? "Receipts",
				merchant: overrides.merchant ?? extracted.merchant ?? null,
				// Amount/date stay per-email even inside a group filing — a shared
				// merchant does not mean a shared price.
				category: overrides.category ?? extracted.category ?? null,
				amount: extracted.amount ?? null,
				currency: extracted.currency ?? "USD",
				purchased_at: extracted.purchased_at ?? null,
			};
		});
		const proposed = await actions.propose(actor.profileId, null, { id: "file_receipt_email", params: { items } });
		if (!proposed) return res.status(422).json({ success: false, message: "Athena couldn't propose that" });
		return res.json({ success: true, action: proposed });
	} catch (err) {
		return fail(res, err, "Failed to propose that group action");
	}
}

/**
 * Dismiss = propose dismiss_email and confirm it immediately. The person's
 * click IS the confirmation here — a second Approve button for "hide this,
 * touching nothing" would be friction with no safety behind it, unlike the
 * Gmail-writing actions above, which always stop for a real approval.
 */
async function dismiss(req, res) {
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const row = await emailTriage.getByUuid(actor.profileId, req.params.uuid);
		if (!row) return res.status(404).json({ success: false, message: "That email could not be found" });
		const proposed = await actions.propose(actor.profileId, null, {
			id: "dismiss_email",
			params: { email_triage_uuid: row.uuid },
		});
		if (!proposed) return res.status(422).json({ success: false, message: "Could not dismiss that" });
		if (proposed.status !== "pending") return res.json({ success: true, action: proposed });
		const confirmed = await actions.confirm(actor.profileId, proposed.uuid, { familyId: actor.familyId });
		return res.json({ success: true, action: confirmed });
	} catch (err) {
		return fail(res, err, "Failed to dismiss that email");
	}
}

/**
 * Propose moving one or more triaged emails to Gmail's Trash — the only
 * genuine delete in this feature, and it still always stops for approval
 * (unlike dismiss, which never touches Gmail at all).
 */
async function deleteEmails(req, res) {
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const uuids = Array.isArray(req.body?.email_triage_uuids) ? req.body.email_triage_uuids : [];
		if (!uuids.length) return res.status(400).json({ success: false, message: "Needs at least one email" });
		const rows = await emailTriage.getRowsByUuids(actor.profileId, uuids);
		if (!rows.length) return res.status(404).json({ success: false, message: "Those emails could not be found" });
		const proposed = await actions.propose(actor.profileId, null, {
			id: "delete_email",
			params: { email_triage_uuids: rows.map((r) => r.uuid) },
		});
		if (!proposed) return res.status(422).json({ success: false, message: "Athena couldn't propose that" });
		return res.json({ success: true, action: proposed });
	} catch (err) {
		return fail(res, err, "Failed to propose deleting that");
	}
}

/**
 * Propose archiving a bundle — the emails the page showed, minus any the
 * person unticked. Only rows still open here are included; the action's own
 * execute() checks again, since mail can leave the inbox before Approve.
 */
async function proposeArchive(req, res) {
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const uuids = Array.isArray(req.body?.email_triage_uuids) ? req.body.email_triage_uuids : [];
		if (!uuids.length) return res.status(400).json({ success: false, message: "Needs at least one email" });
		const open = (await emailTriage.getRowsByUuids(actor.profileId, uuids.slice(0, 100))).filter((r) => r.status === "new");
		if (!open.length) return res.status(404).json({ success: false, message: "Those emails are no longer in your inbox" });
		const proposed = await actions.propose(actor.profileId, null, {
			id: "archive_emails",
			params: { email_triage_uuids: open.map((r) => r.uuid) },
		});
		if (!proposed) return res.status(422).json({ success: false, message: "Athena couldn't propose that" });
		return res.json({ success: true, action: proposed });
	} catch (err) {
		return fail(res, err, "Failed to propose archiving those");
	}
}

/**
 * Propose adding the events from several travel/school emails at once (Mail
 * card phase 3). Only open emails where Athena found a date go in; the rest
 * keep the one-at-a-time path, where the person can type the date in.
 */
async function proposeEvents(req, res) {
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const uuids = Array.isArray(req.body?.email_triage_uuids) ? req.body.email_triage_uuids : [];
		if (!uuids.length) return res.status(400).json({ success: false, message: "Needs at least one email" });
		const rows = (await emailTriage.getRowsByUuids(actor.profileId, uuids.slice(0, 10)))
			.filter((r) => r.status === "new" && (r.category === "travel" || r.category === "school"));
		const items = rows.map((r) => ({ row: r, extracted: parsedExtracted(r) }))
			.filter(({ extracted }) => hasEventDate(extracted))
			.map(({ row, extracted }) => eventParams(row, extracted));
		if (!items.length) return res.status(404).json({ success: false, message: "None of those emails has a date Athena could read — open each to add one" });
		const proposed = await actions.propose(actor.profileId, null, { id: "add_email_events", params: { items } });
		if (!proposed) return res.status(422).json({ success: false, message: "Athena couldn't propose that — check that Google Calendar is still connected" });
		return res.json({ success: true, action: proposed });
	} catch (err) {
		return fail(res, err, "Failed to propose those events");
	}
}

/**
 * Propose unsubscribing from senders (Mail card phase 4). The body names one
 * stored email per sender; only open rows that carry a one-click link go in.
 */
async function proposeUnsubscribe(req, res) {
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const uuids = Array.isArray(req.body?.email_triage_uuids) ? req.body.email_triage_uuids : [];
		if (!uuids.length) return res.status(400).json({ success: false, message: "Needs at least one sender" });
		const rows = (await emailTriage.getRowsByUuids(actor.profileId, uuids.slice(0, 10)))
			.filter((r) => r.status === "new" && parsedExtracted(r)?.unsub);
		if (!rows.length) return res.status(404).json({ success: false, message: "None of those senders offers a one-click unsubscribe" });
		const items = rows.map((r) => ({ email_triage_uuid: r.uuid, sender: r.from_name || r.from_address || r.group_key }));
		const proposed = await actions.propose(actor.profileId, null, { id: "unsubscribe_senders", params: { items } });
		if (!proposed) return res.status(422).json({ success: false, message: "Athena couldn't propose that" });
		return res.json({ success: true, action: proposed });
	} catch (err) {
		return fail(res, err, "Failed to propose unsubscribing");
	}
}

/** A suggested reply, as text to edit in the drawer. Writes nothing anywhere. */
async function suggestReply(req, res) {
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const [row] = await emailTriage.getRowsByUuids(actor.profileId, [req.params.uuid]);
		if (!row || row.status !== "new") return res.status(404).json({ success: false, message: "That email is no longer open" });
		return res.json({ success: true, body: await emailDraft.writeDraft(actor.profileId, row) });
	} catch (err) {
		return fail(res, err, "Athena couldn't write a reply just now");
	}
}

/** Propose saving the (edited) reply to Gmail's Drafts. Still needs Approve. */
async function proposeDraft(req, res) {
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const [row] = await emailTriage.getRowsByUuids(actor.profileId, [req.params.uuid]);
		if (!row || row.status !== "new") return res.status(404).json({ success: false, message: "That email is no longer open" });
		const proposed = await actions.propose(actor.profileId, null, {
			id: "draft_reply",
			params: { email_triage_uuid: row.uuid, body: req.body?.body, to_name: row.from_name || row.from_address },
		});
		if (!proposed) return res.status(422).json({ success: false, message: "Athena couldn't propose that draft" });
		return res.json({ success: true, action: proposed });
	} catch (err) {
		return fail(res, err, "Failed to propose that draft");
	}
}

module.exports = { list, detail, scan, propose, proposeGroup, dismiss, deleteEmails, proposeArchive, proposeEvents, proposeUnsubscribe, suggestReply, proposeDraft };
