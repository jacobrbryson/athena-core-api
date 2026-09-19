/**
 * Athena asking a device to take a look.
 *
 * The action layer executes server-side, and a camera is not on the server.
 * So `look_through_camera` executes by writing a request here, and whichever
 * of the person's open clients is listening fulfils it.
 *
 * ## A request is not an instruction
 *
 * Nothing here can make a camera open. A row is a statement that Athena would
 * like to look, carrying the reason she gave, and the client decides whether
 * it can honour that — it checks the person's own settings, puts the camera
 * indicator up for the duration, and declines if it cannot.
 *
 * The authority behind the row has already been established before it exists:
 * `actions/index.js` only reaches `execute()` after the registry recognised
 * the id, `normalize()` vouched for the params, live access was re-checked,
 * and either the person pressed Approve or a standing approval they granted
 * stood in for their finger. Revoking that approval
 * (`athena_action_authority`) stops rows being written at all.
 *
 * ## Why the TTL is short
 *
 * A request is about a moment. One that has sat for minutes is no longer about
 * that moment, and a camera opening long after the conversation moved on is
 * indistinguishable, from the person's side, from one opening at random.
 */
const { randomUUID } = require("crypto");
const pool = require("../helpers/db");

/** How long a device has to answer before the moment has passed. */
const TTL_MS = 90_000;

/** Keep it to a handful — a backlog would mean several cameras opening at once. */
const MAX_PENDING = 3;

function publicRequest(row) {
	return {
		uuid: row.uuid,
		reason: row.reason || null,
		prefer: row.prefer || null,
		created_at: row.created_at,
		expires_at: row.expires_at,
	};
}

/**
 * Record that Athena would like a look. Returns the request, or null when she
 * already has more outstanding than anyone should have to notice.
 */
async function create(profileId, { reason = null, prefer = null, actionUuid = null } = {}) {
	const pid = Number(profileId);
	if (!Number.isFinite(pid) || pid <= 0) return null;

	const [[{ outstanding }]] = await pool.query(
		`SELECT COUNT(*) AS outstanding FROM athena_look_request
		  WHERE profile_id = ? AND status = 'pending' AND expires_at > NOW()`,
		[pid]
	);
	// She asked and nobody answered. Piling on more would mean a queue of
	// cameras opening the moment a device does appear.
	if (outstanding >= MAX_PENDING) return null;

	const uuid = randomUUID();
	await pool.query(
		`INSERT INTO athena_look_request
			(uuid, profile_id, action_uuid, reason, prefer, expires_at)
		 VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
		[
			uuid,
			pid,
			actionUuid,
			typeof reason === "string" ? reason.slice(0, 300) : null,
			prefer === "front" || prefer === "room" ? prefer : null,
			Math.round(TTL_MS / 1000),
		]
	);
	return { uuid, reason, prefer };
}

/** What a device should act on right now. Oldest first — she asked first. */
async function pendingFor(profileId) {
	const pid = Number(profileId);
	if (!Number.isFinite(pid) || pid <= 0) return [];
	const [rows] = await pool.query(
		`SELECT uuid, reason, prefer, created_at, expires_at
		   FROM athena_look_request
		  WHERE profile_id = ? AND status = 'pending' AND expires_at > NOW()
		  ORDER BY created_at ASC LIMIT ?`,
		[pid, MAX_PENDING]
	);
	return rows.map(publicRequest);
}

/**
 * A device looked. Guarded on `status = 'pending'` so two open tabs answering
 * the same request produce one fulfilment and one no-op, rather than two
 * cameras opening and two frames going up.
 */
async function fulfil(profileId, uuid) {
	const pid = Number(profileId);
	if (!Number.isFinite(pid) || pid <= 0 || typeof uuid !== "string" || !uuid) return false;
	const [result] = await pool.query(
		`UPDATE athena_look_request SET status = 'fulfilled', fulfilled_at = NOW()
		  WHERE uuid = ? AND profile_id = ? AND status = 'pending'`,
		[uuid, pid]
	);
	return (result?.affectedRows ?? 0) > 0;
}

/**
 * The device cannot or will not look — no camera, permission refused, or the
 * person has told it not to. Recorded rather than ignored, because "she asked
 * and was refused" and "she never asked" must not look the same afterwards.
 */
async function decline(profileId, uuid, reason = null) {
	const pid = Number(profileId);
	if (!Number.isFinite(pid) || pid <= 0 || typeof uuid !== "string" || !uuid) return false;
	const [result] = await pool.query(
		`UPDATE athena_look_request SET status = 'declined'
		  WHERE uuid = ? AND profile_id = ? AND status = 'pending'`,
		[uuid, pid]
	);
	if ((result?.affectedRows ?? 0) > 0 && reason) {
		console.warn(`[lookRequests] ${uuid} declined by device: ${reason}`);
	}
	return (result?.affectedRows ?? 0) > 0;
}

/** Nightly tidy. `pendingFor` already filters on expiry, so this is hygiene. */
async function expireStale() {
	const [result] = await pool.query(
		`UPDATE athena_look_request SET status = 'expired'
		  WHERE status = 'pending' AND expires_at <= NOW()`
	);
	return result?.affectedRows ?? 0;
}

module.exports = { TTL_MS, MAX_PENDING, create, pendingFor, fulfil, decline, expireStale };
