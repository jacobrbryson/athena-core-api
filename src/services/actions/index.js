/**
 * The action layer: how Athena does something instead of only saying it.
 *
 * Every tool Athena had before this was a `get_`. She could tell you your 2pm
 * collided with your flight and could not move the 2pm. This module is the
 * actuator, and its whole design is about keeping the human as the one who
 * decides.
 *
 * ## Why proposals and not tool calls
 *
 * The chat path drives the model through a structured-output schema
 * (controllers/prompt.js RESPONSE_SCHEMA), not function calling. So Athena
 * cannot invoke anything: she can only fill in a `proposed_action` field, and
 * the backend decides what — if anything — that becomes. The gate is
 * structural rather than a rule the model is asked to follow, which matters
 * because model output is untrusted input. Prompt injection through a
 * calendar event title can at most cause a proposal the person is shown and
 * declines; it cannot cause an execution.
 *
 *     model reply ──► propose() ──► athena_action(pending) ──► the person
 *                        │                                        │
 *              registry.normalize()                          confirm()
 *              (untrusted -> vouched)                             │
 *                                                            execute()
 *
 * ## The four gates every execution passes
 *
 *   1. The action id is in the registry. Unknown ids are dropped, never run.
 *   2. `normalize()` vouched for the exact params stored on the row. What the
 *      person approves is that json, not the sentence Athena said about it.
 *   3. Live access still holds, re-checked at execute time and not inherited
 *      from whenever the proposal was made (security/access.js).
 *   4. The pending -> executing transition is a guarded UPDATE. A proposal
 *      executes exactly once, however many times Approve is pressed.
 *
 * Standing approvals skip gate 4's human, never gates 1-3, and never the
 * audit row. They change who pressed the button, not whether the press is
 * recorded.
 */

const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");
const access = require("../../security/access");
const consent = require("../consent");
const credentials = require("../credentials");
const family = require("../family");
const registry = require("./registry");

/**
 * How long a proposal stays approvable.
 *
 * Short on purpose. "Put the dentist in for 2pm" means nothing tomorrow, and
 * a proposal the person never noticed must not sit there waiting to be
 * approved out of context. Expired proposals are re-proposed as new rows, so
 * the cost of being strict is one extra sentence from Athena.
 */
const PROPOSAL_TTL_MS = 15 * 60 * 1000;

/** Rows a person may still act on, newest first. */
const PENDING_COLUMNS = `uuid, action_id, params, rationale, summary, status,
	approval, result_ref, error, created_at, expires_at, decided_at, executed_at`;

function failure(message, status, code) {
	return Object.assign(new Error(message), { status, code });
}

/**
 * Append to the existing access audit.
 *
 * `subject` is the profile, `action` the verb, and `detail` the registry
 * action id — stored in the audit's `actor` column, which is the only free
 * text the table has. This is a deliberate off-label use: the full record of
 * what happened lives in `athena_action`, and this row exists so that a
 * single scan of the access audit shows Athena acting at all, next to every
 * other access event. Keep passing the action id so that scan stays readable.
 *
 * Deliberately best-effort at the edges but never skipped: an audit write
 * that throws must not roll back an execution that already happened at the
 * provider, because the provider's record would then be the only one. A
 * failure here is logged loudly instead.
 */
async function audit(subject, action, detail = null) {
	try {
		await pool.query(
			"INSERT INTO athena_access_audit (subject, action, actor) VALUES (?, ?, ?)",
			[String(subject).slice(0, 255), action.slice(0, 40), detail ? String(detail).slice(0, 255) : null]
		);
	} catch (err) {
		console.error("[actions] AUDIT WRITE FAILED", action, subject, err.message);
	}
}

function publicAction(row) {
	return {
		uuid: row.uuid,
		action_id: row.action_id,
		label: registry.get(row.action_id)?.label || row.action_id,
		// Stored at propose time, so the audit shows the sentence the person
		// actually read even if summarize() is reworded later.
		summary: row.summary,
		rationale: row.rationale,
		params: typeof row.params === "string" ? safeJson(row.params) : row.params,
		status: row.status,
		approval: row.approval,
		reversible: registry.get(row.action_id)?.reversible ?? false,
		result_ref: row.result_ref,
		error: row.error,
		created_at: row.created_at,
		expires_at: row.expires_at,
		executed_at: row.executed_at,
	};
}

function safeJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// What Athena is allowed to propose right now
// ---------------------------------------------------------------------------

/**
 * The actions this person can actually be offered, with the reason any are
 * missing. Offering an action whose provider isn't linked only teaches the
 * model to propose something that will fail in front of the person.
 *
 * Never throws: a failure here costs Athena her actions for one turn, not the
 * reply. It fails closed — an unreadable consent or credential list means
 * no actions, not all of them.
 */
async function availableFor(profileId) {
	if (!profileId) return [];
	let linked = new Set();
	let consented = false;
	try {
		const rows = await credentials.list(profileId);
		linked = new Set(
			(rows || []).filter((r) => r.status === "active").map((r) => r.provider)
		);
	} catch (err) {
		console.warn("[actions] credential list failed:", err.message);
		return [];
	}
	try {
		consented = await consent.hasConsentForProfile(profileId, "action_authority");
	} catch {
		return [];
	}
	return registry.ACTIONS.filter((a) => {
		if (a.consentType === "action_authority" && !consented) return false;
		if (a.provider && !linked.has(a.provider)) return false;
		return true;
	});
}

/**
 * The prompt block naming what she can propose and how to fill it in.
 *
 * Returns null when there is nothing available, which is the common case for
 * a child session or an unconsented family — and a null block is how she
 * stays silent about actions she cannot take, rather than offering them and
 * failing.
 */
function promptBlock(actions) {
	if (!actions || !actions.length) return null;
	const lines = [
		"# Things you can DO (not just say)",
		"",
		"You cannot perform any of these yourself. You propose one and the person",
		"approves or declines it — so never claim it is done, and never say you",
		'have "already" done it. Say what you are about to propose, in one',
		'sentence, in your `response` (e.g. "Want me to put that on your',
		'calendar?"), and put the structured proposal in `proposed_action`.',
		"",
		"Propose at most ONE action per reply, and only when the person actually",
		"asked for something to change. A question about what is already there is",
		"answered by reading, which needs no approval. If you are unsure what they",
		"want, ask in `response` and propose nothing.",
		"",
	];
	for (const action of actions) {
		lines.push(`## ${action.id}`);
		lines.push(action.describe);
		lines.push("Parameters:");
		for (const [name, description] of Object.entries(action.params)) {
			lines.push(`- ${name}: ${description}`);
		}
		lines.push("");
	}
	lines.push(
		"Shape: `proposed_action: { id, params: { ... }, rationale }`. `rationale`",
		"is one short line on why, shown to the person on the approval card.",
		"Omit `proposed_action` entirely when you are not proposing anything."
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

/**
 * Turn an untrusted `proposed_action` from a model reply into a real pending
 * proposal, or nothing.
 *
 * Returns null for every "she shouldn't have proposed that" case rather than
 * throwing, because none of them should cost the person their reply: the
 * reply is already written and the proposal is an extra. The reasons are
 * logged, and the nightly review reads them as a prompt problem.
 *
 * Executes immediately, without a card, only when the person has granted a
 * standing authority for that exact action.
 */
async function propose(profileId, sessionId, raw, ctx = {}) {
	if (!profileId || !raw || typeof raw !== "object") return null;

	const action = registry.get(raw.id);
	if (!action) {
		console.warn("[actions] model proposed an unknown action:", raw.id);
		return null;
	}

	// Re-derive availability rather than trusting that the prompt only offered
	// what was allowed. A model can name an action it was never told about.
	const available = await availableFor(profileId);
	if (!available.some((a) => a.id === action.id)) {
		console.warn(`[actions] ${action.id} proposed but not available to profile ${profileId}`);
		return null;
	}

	let params;
	try {
		params = action.normalize(raw.params || {}, ctx);
	} catch (err) {
		// The interesting failure. A model that keeps proposing invalid params
		// is a prompt bug, and this line is where it shows up.
		console.warn(`[actions] ${action.id} params rejected: ${err.message}`);
		return null;
	}

	const summary = action.summarize(params);
	const uuid = randomUUID();
	const authority = action.standing ? await liveAuthority(profileId, action.id) : null;

	await pool.query(
		`INSERT INTO athena_action
			(uuid, profile_id, session_id, action_id, params, rationale, summary, status, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? SECOND))`,
		[
			uuid,
			profileId,
			sessionId || null,
			action.id,
			JSON.stringify(params),
			typeof raw.rationale === "string" ? raw.rationale.slice(0, 500) : null,
			summary.slice(0, 500),
			Math.round(PROPOSAL_TTL_MS / 1000),
		]
	);
	await audit(profileId, "action_proposed", action.id);

	if (authority) {
		// A standing approval stands in for the person's finger on the button.
		// It goes through the identical execute path, so gates 1-4 all still
		// run and the audit row is identical but for `approval`.
		return runPending(profileId, uuid, { approval: "standing", authorityId: authority.id, ctx });
	}
	return get(profileId, uuid);
}

// ---------------------------------------------------------------------------
// Confirm / decline
// ---------------------------------------------------------------------------

/** One proposal of this person's. Scoped by profile, so uuids aren't guessable authority. */
async function get(profileId, uuid) {
	const [rows] = await pool.query(
		`SELECT ${PENDING_COLUMNS} FROM athena_action WHERE uuid = ? AND profile_id = ? LIMIT 1`,
		[uuid, profileId]
	);
	return rows[0] ? publicAction(rows[0]) : null;
}

/** This person's proposals still awaiting them, expired ones excluded. */
async function listPending(profileId) {
	const [rows] = await pool.query(
		`SELECT ${PENDING_COLUMNS} FROM athena_action
		 WHERE profile_id = ? AND status = 'pending' AND expires_at > NOW()
		 ORDER BY created_at DESC LIMIT 20`,
		[profileId]
	);
	return rows.map(publicAction);
}

/** Recent history, whatever became of it. What "what did Athena do?" reads. */
async function listRecent(profileId, limit = 25) {
	const [rows] = await pool.query(
		`SELECT ${PENDING_COLUMNS} FROM athena_action
		 WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?`,
		[profileId, Math.min(Math.max(Number(limit) || 25, 1), 100)]
	);
	return rows.map(publicAction);
}

/** A person pressed Approve. */
async function confirm(profileId, uuid, ctx = {}) {
	return runPending(profileId, uuid, { approval: "human", ctx });
}

/**
 * Execute a pending proposal. The only path to a provider call.
 *
 * The claim is a guarded UPDATE with `status = 'pending'` in the WHERE clause
 * and expiry checked in SQL, so concurrency is settled by the database rather
 * than by reading the row and hoping. A double-tapped Approve loses the race
 * on the second press and is told the proposal is no longer pending, which is
 * true.
 */
async function runPending(profileId, uuid, { approval, authorityId = null, ctx = {} }) {
	// Gate 3. Not inherited from propose time: a grant revoked in between must
	// stop the execution, and a background caller must be charged to an
	// owner-configured identity that passes the same live check.
	await access.assertModelAccess();

	const [claim] = await pool.query(
		`UPDATE athena_action
		 SET status = 'executing', approval = ?, authority_id = ?, decided_at = NOW()
		 WHERE uuid = ? AND profile_id = ? AND status = 'pending' AND expires_at > NOW()`,
		[approval, authorityId, uuid, profileId]
	);
	if (!claim.affectedRows) {
		// Either already decided, expired, or not theirs. Reported the same way
		// for all three so a uuid probe learns nothing from the difference.
		const existing = await get(profileId, uuid);
		throw failure(
			existing ? `That request is already ${existing.status}` : "No such request",
			409,
			"not_pending"
		);
	}

	const [rows] = await pool.query(
		"SELECT action_id, params FROM athena_action WHERE uuid = ? LIMIT 1",
		[uuid]
	);
	const row = rows[0];
	const action = registry.get(row?.action_id);
	if (!action) {
		// Gate 1, at execute time. An action id that has left the registry
		// since it was proposed fails closed — a removed action must not be
		// executable from a row that predates its removal.
		await settle(uuid, "failed", { error: "That action is no longer available" });
		await audit(profileId, "action_failed", row?.action_id || "unknown");
		throw failure("That action is no longer available", 409, "unknown_action");
	}

	const params = typeof row.params === "string" ? safeJson(row.params) : row.params;
	try {
		const { ref, detail } = await action.execute(profileId, params, {
			...ctx,
			familyId: ctx.familyId ?? (await familyIdFor(profileId)),
		});
		await settle(uuid, "done", { resultRef: ref, detail });
		await audit(profileId, "action_executed", action.id);
	} catch (err) {
		await settle(uuid, "failed", { error: err.message });
		await audit(profileId, "action_failed", action.id);
		// Re-thrown so the route can answer honestly. The row is already
		// terminal, so the person is never left with a proposal that looks
		// pending after it failed.
		throw Object.assign(err, { actionUuid: uuid });
	}
	return get(profileId, uuid);
}

/** Terminal write. Never conditional on status: the claim already won the race. */
async function settle(uuid, status, { resultRef = null, error = null } = {}) {
	await pool.query(
		`UPDATE athena_action
		 SET status = ?, result_ref = ?, error = ?, executed_at = NOW()
		 WHERE uuid = ?`,
		[status, resultRef ? String(resultRef).slice(0, 255) : null, error ? String(error).slice(0, 500) : null, uuid]
	);
}

/** A person pressed Decline. Recorded, not deleted: a "no" is worth keeping. */
async function decline(profileId, uuid) {
	const [result] = await pool.query(
		`UPDATE athena_action SET status = 'declined', decided_at = NOW()
		 WHERE uuid = ? AND profile_id = ? AND status = 'pending'`,
		[uuid, profileId]
	);
	if (!result.affectedRows) throw failure("No such request", 409, "not_pending");
	const declined = await get(profileId, uuid);
	// The action id, not the uuid, so a scan of the access audit reads the same
	// way for a refusal as it does for an execution.
	await audit(profileId, "action_declined", declined?.action_id || null);
	return declined;
}

/**
 * Mark everything nobody answered in time. Idempotent; safe to run often.
 * Called from the nightly job so the table doesn't accumulate rows that read
 * as pending forever.
 */
async function expireStale() {
	const [result] = await pool.query(
		"UPDATE athena_action SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW()"
	);
	return result.affectedRows || 0;
}

// ---------------------------------------------------------------------------
// Standing approvals
// ---------------------------------------------------------------------------

async function familyIdFor(profileId) {
	try {
		const f = await family.getFamilyForProfile(profileId);
		return f ? f.id : null;
	} catch {
		return null;
	}
}

/** A live, unrevoked, unexpired authority for this action, or null. */
async function liveAuthority(profileId, actionId) {
	const [rows] = await pool.query(
		`SELECT id, action_id, expires_at FROM athena_action_authority
		 WHERE profile_id = ? AND action_id = ? AND revoked_at IS NULL
		   AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
		[profileId, actionId]
	);
	return rows[0] || null;
}

async function listAuthorities(profileId) {
	const [rows] = await pool.query(
		`SELECT action_id, expires_at, created_at FROM athena_action_authority
		 WHERE profile_id = ? AND revoked_at IS NULL
		   AND (expires_at IS NULL OR expires_at > NOW())
		 ORDER BY created_at DESC`,
		[profileId]
	);
	return rows.map((r) => ({
		action_id: r.action_id,
		label: registry.get(r.action_id)?.label || r.action_id,
		expires_at: r.expires_at,
		created_at: r.created_at,
	}));
}

/**
 * "You may do this without asking me each time."
 *
 * Granted only for actions the registry marks `standing`, and only by the
 * person themselves — the caller's own authenticated profile, never a
 * profile id from a request body, because a standing approval is exactly the
 * thing worth forging. Requires the same consent as proposing does: a family
 * that has not accepted the action consent cannot arrive here and skip it.
 */
async function grantAuthority(profileId, actionId, { expiresAt = null } = {}) {
	const action = registry.get(actionId);
	if (!action) throw failure("No such action", 404, "unknown_action");
	if (!action.standing) {
		throw failure(`${action.label} always asks first`, 400, "standing_not_allowed");
	}
	if (
		action.consentType &&
		!(await consent.hasConsentForProfile(profileId, action.consentType))
	) {
		throw failure("That needs to be turned on in your consent settings first", 403, "consent_required");
	}
	await pool.query(
		`INSERT INTO athena_action_authority (profile_id, action_id, granted_by, expires_at)
		 VALUES (?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at), revoked_at = NULL,
		   granted_by = VALUES(granted_by), created_at = CURRENT_TIMESTAMP`,
		[profileId, actionId, profileId, expiresAt]
	);
	await audit(profileId, "action_authority_granted", actionId);
	return listAuthorities(profileId);
}

/** Revoke. Leaves every athena_action row it ever authorized findable. */
async function revokeAuthority(profileId, actionId) {
	const [result] = await pool.query(
		`UPDATE athena_action_authority SET revoked_at = NOW()
		 WHERE profile_id = ? AND action_id = ? AND revoked_at IS NULL`,
		[profileId, actionId]
	);
	if (result.affectedRows) await audit(profileId, "action_authority_revoked", actionId);
	return listAuthorities(profileId);
}

module.exports = {
	PROPOSAL_TTL_MS,
	availableFor,
	promptBlock,
	propose,
	get,
	listPending,
	listRecent,
	confirm,
	decline,
	expireStale,
	listAuthorities,
	grantAuthority,
	revokeAuthority,
	liveAuthority,
};
