/**
 * Keeps email_triage in step with the Gmail inbox — Mail card phase 1
 * (docs/architecture/mail-card.md).
 *
 * The triage table used to learn about mail only when someone pressed "Scan
 * more", and never learned that a message had been archived or deleted in the
 * Gmail app, so the card showed mail that was already dealt with. A pass here:
 *
 *   incremental  follow Gmail's history from the saved historyId: new inbox
 *                mail becomes a 'pending' row (metadata only, no model), and
 *                a message that left the inbox marks its open row 'gone'
 *   bootstrap    no cursor yet, or Gmail says it expired (404): take the
 *                current historyId FIRST, so nothing arriving during the
 *                listing is missed, then reconcile open rows against the inbox
 *   reconcile    compare every open row with the inbox; also run daily by the
 *                mail job, as a backstop for anything history missed
 *
 * Classification of pending rows is not done here: it needs a model, so it
 * runs in the mail job (src/jobs/mail.js) or on the next "Scan more".
 * Nothing here moves, labels or deletes anything in Gmail — every call is a
 * read, and every write is to Athena's own table.
 */
const pool = require("../helpers/db");
const gmail = require("./connectors/gmail");
const triage = require("./emailTriage");

const STALE_MS = 5 * 60_000;
const RECONCILE_EVERY_MS = 24 * 3_600_000;
const LEASE_SECONDS = 120;
const MAX_HISTORY_PAGES = 10;
const MAX_NEW_PER_PASS = 100;
const RECONCILE_PAGES = 30; // 3,000 inbox ids; ids-only listing is cheap

/** Take the profile's lease, creating its row on first use. Null when another pass holds it. */
async function claim(profileId) {
	await pool.query("INSERT IGNORE INTO email_sync_state (profile_id) VALUES (?)", [profileId]);
	const [result] = await pool.query(
		`UPDATE email_sync_state SET lease_until = DATE_ADD(NOW(3), INTERVAL ? SECOND)
		 WHERE profile_id = ? AND (lease_until IS NULL OR lease_until < NOW(3))`,
		[LEASE_SECONDS, profileId]
	);
	if (!result.affectedRows) return null;
	const [rows] = await pool.query("SELECT * FROM email_sync_state WHERE profile_id = ?", [profileId]);
	return rows[0] || null;
}

async function release(profileId, { historyId, reconciled }) {
	await pool.query(
		`UPDATE email_sync_state SET history_id = ?, synced_at = NOW(3), lease_until = NULL, last_error = NULL
		 ${reconciled ? ", reconciled_at = NOW(3)" : ""} WHERE profile_id = ?`,
		[historyId, profileId]
	);
}

async function fail(profileId, err) {
	await pool
		.query("UPDATE email_sync_state SET lease_until = NULL, last_error = ? WHERE profile_id = ?", [
			String(err?.message || err).slice(0, 300),
			profileId,
		])
		.catch(() => {});
}

const labelsOf = (message) => message?.labelIds || [];

/**
 * Where each touched message ended up: 'in' the inbox or 'out' of it. History
 * records are in order, so the last word on a message wins — archived and then
 * moved back is 'in'.
 */
function changesFrom(records) {
	const where = new Map();
	for (const h of records) {
		for (const a of h.messagesAdded || []) if (labelsOf(a.message).includes("INBOX")) where.set(a.message.id, "in");
		for (const a of h.labelsAdded || []) {
			if (a.labelIds?.includes("TRASH") || a.labelIds?.includes("SPAM")) where.set(a.message.id, "out");
			else if (a.labelIds?.includes("INBOX")) where.set(a.message.id, "in");
		}
		for (const a of h.labelsRemoved || []) if (a.labelIds?.includes("INBOX")) where.set(a.message.id, "out");
		for (const d of h.messagesDeleted || []) where.set(d.message.id, "out");
	}
	return where;
}

async function setStatus(profileId, ids, from, to) {
	if (!ids.length) return 0;
	const [result] = await pool.query(
		`UPDATE email_triage SET status = ? WHERE profile_id = ? AND status = ? AND gmail_message_id IN (?)`,
		[to, profileId, from, ids]
	);
	return result.affectedRows || 0;
}

async function apply(profileId, where, { maxNew }) {
	const out = [...where].filter(([, w]) => w === "out").map(([id]) => id);
	const into = [...where].filter(([, w]) => w === "in").map(([id]) => id);
	const gone = await setStatus(profileId, out, "new", "gone");
	const returned = await setStatus(profileId, into, "gone", "new");
	const known = await triage.alreadyTriaged(profileId, into);
	const fresh = into.filter((id) => !known.has(id));
	// Past the cap, the rest are still in the inbox, newest first — exactly
	// where the next "Scan more" starts — so nothing is lost, only deferred.
	const added = await triage.insertPending(profileId, fresh.slice(0, maxNew));
	return { added, gone, returned, deferred: Math.max(0, fresh.length - maxNew) };
}

async function readHistory(profileId, startHistoryId) {
	const records = [];
	let historyId = startHistoryId;
	let pageToken;
	for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
		const data = await gmail.history(profileId, { startHistoryId, pageToken });
		records.push(...(data?.history || []));
		historyId = data?.historyId ? String(data.historyId) : historyId;
		pageToken = data?.nextPageToken;
		if (!pageToken) return { records, historyId };
	}
	// Ran out of pages: resume after the last record actually read, not at the
	// mailbox's newest id, or the unread remainder would be skipped for good.
	return { records, historyId: records.length ? String(records[records.length - 1].id) : startHistoryId };
}

/**
 * Mark open rows whose message is no longer in the inbox 'gone'. With a
 * complete listing that is exact. Past RECONCILE_PAGES it is not, so up to
 * `verifyLimit` of the unlisted rows are checked one by one.
 */
async function reconcile(profileId, { verifyLimit = 0 } = {}) {
	const inbox = new Set();
	let pageToken;
	let complete = false;
	for (let page = 0; page < RECONCILE_PAGES; page++) {
		const list = await gmail.listInbox(profileId, { pageToken, maxResults: 100 });
		for (const m of list?.messages || []) inbox.add(m.id);
		pageToken = list?.nextPageToken;
		if (!pageToken) {
			complete = true;
			break;
		}
	}
	const [rows] = await pool.query(
		"SELECT gmail_message_id FROM email_triage WHERE profile_id = ? AND status = 'new'",
		[profileId]
	);
	const missing = rows.map((r) => r.gmail_message_id).filter((id) => !inbox.has(id));
	let gone = complete ? missing : [];
	let unverified = 0;
	if (!complete) {
		for (const id of missing.slice(0, verifyLimit)) {
			try {
				const message = await gmail.getMessage(profileId, id, { format: "minimal" });
				if (!labelsOf(message).includes("INBOX")) gone.push(id);
			} catch (err) {
				if (err.providerStatus === 404) gone.push(id);
				else throw err;
			}
		}
		unverified = Math.max(0, missing.length - verifyLimit);
	}
	return { gone: await setStatus(profileId, gone, "new", "gone"), unverified };
}

/**
 * One pass for one profile. `verifyLimit` is 0 on the dashboard path (it must
 * stay quick) and larger in the job. Returns what changed, or { skipped }
 * when another pass holds the lease.
 */
async function sync(profileId, { maxNew = MAX_NEW_PER_PASS, verifyLimit = 0 } = {}) {
	const state = await claim(profileId);
	if (!state) return { skipped: "busy" };
	try {
		if (state.history_id) {
			try {
				const { records, historyId } = await readHistory(profileId, state.history_id);
				const result = await apply(profileId, changesFrom(records), { maxNew });
				await release(profileId, { historyId, reconciled: false });
				return { mode: "incremental", ...result };
			} catch (err) {
				if (err.providerStatus !== 404) throw err;
				// The cursor expired (Gmail keeps about a week): start over below.
			}
		}
		const historyId = await gmail.mailboxHistoryId(profileId);
		const result = await reconcile(profileId, { verifyLimit });
		await release(profileId, { historyId, reconciled: result.unverified === 0 });
		return { mode: "bootstrap", ...result };
	} catch (err) {
		await fail(profileId, err);
		throw err;
	}
}

/** The dashboard's call: a quick pass only when the last one is over five minutes old. */
async function syncIfStale(profileId) {
	const [rows] = await pool.query("SELECT synced_at FROM email_sync_state WHERE profile_id = ?", [profileId]);
	const last = rows[0]?.synced_at ? new Date(rows[0].synced_at).getTime() : 0;
	if (Date.now() - last < STALE_MS) return { skipped: "fresh" };
	return sync(profileId, { verifyLimit: 0 });
}

/** The daily backstop, for the job: a full reconcile when the last one is a day old. */
async function reconcileIfDue(profileId, { verifyLimit = 100 } = {}) {
	const [rows] = await pool.query("SELECT reconciled_at FROM email_sync_state WHERE profile_id = ?", [profileId]);
	const last = rows[0]?.reconciled_at ? new Date(rows[0].reconciled_at).getTime() : 0;
	if (Date.now() - last < RECONCILE_EVERY_MS) return { skipped: "recent" };
	const result = await reconcile(profileId, { verifyLimit });
	if (result.unverified === 0) {
		await pool.query("UPDATE email_sync_state SET reconciled_at = NOW(3) WHERE profile_id = ?", [profileId]);
	}
	return result;
}

module.exports = { sync, syncIfStale, reconcile, reconcileIfDue, changesFrom, STALE_MS };
