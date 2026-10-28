/**
 * The notification inbox: every push Athena sends is also kept until the
 * person acknowledges it.
 *
 * A phone notification disappears the moment it is tapped, and tapping opens
 * the app before it can be read — so the push alone could lose the message.
 * `push.sendToProfile` records here first, which makes the inbox the system of
 * record and the push one of the ways of announcing it.
 *
 * It is a record, not a gate. It decides nothing about whether anyone is
 * disturbed (that stays upstream), and it never drops anything: a row exists
 * even when push is off or no device is paired. Only an acknowledgement, from
 * the app or from the phone's Acknowledge button, clears one.
 */

const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");

/** Diagnostics are not messages; keeping them would clutter the inbox. */
const UNRECORDED_KINDS = new Set(["test"]);

const LIMIT = 100;

/**
 * Keep one notification. Idempotent on (profile, source uuid): a retry or
 * redelivery of the same push returns the existing row instead of a second.
 * Returns { uuid } or null when nothing was kept. Never throws.
 */
async function record(profileId, { title, body, data } = {}) {
	try {
		const kind = String(data?.kind || "general").slice(0, 40);
		if (!profileId || !title || !body || UNRECORDED_KINDS.has(kind)) return null;
		const source = data?.uuid ? String(data.uuid).slice(0, 80) : null;
		const uuid = randomUUID();
		const [res] = await pool.query(
			`INSERT IGNORE INTO athena_notification (uuid, source_uuid, profile_id, kind, title, body, data)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[uuid, source, profileId, kind, String(title).slice(0, 200), String(body), JSON.stringify(data || {})]
		);
		return { uuid, created: res?.affectedRows > 0 };
	} catch (err) {
		console.warn("[notifications] could not record:", err.message);
		return null;
	}
}

function shape(row) {
	let data = row.data;
	if (typeof data === "string") {
		try { data = JSON.parse(data); } catch { data = {}; }
	}
	return {
		uuid: row.uuid,
		kind: row.kind,
		title: row.title,
		body: row.body,
		url: typeof data?.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : null,
		createdAt: row.created_at,
		acknowledgedAt: row.acknowledged_at || null,
	};
}

/** Everything still waiting (newest first), plus the last week of what was acknowledged. */
async function list(profileId) {
	const [open] = await pool.query(
		`SELECT * FROM athena_notification WHERE profile_id = ? AND acknowledged_at IS NULL
		 ORDER BY created_at DESC LIMIT ${LIMIT}`,
		[profileId]
	);
	const [done] = await pool.query(
		`SELECT * FROM athena_notification WHERE profile_id = ? AND acknowledged_at IS NOT NULL
		   AND acknowledged_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY)
		 ORDER BY acknowledged_at DESC LIMIT 20`,
		[profileId]
	);
	return { unacknowledged: open.map(shape), recent: done.map(shape) };
}

/**
 * Acknowledge by our uuid or by the sender's (the phone button sends the
 * latter). Returns how many rows changed; 0 for an unknown or already
 * acknowledged one, which is not an error.
 */
async function acknowledge(profileId, id, via = "app") {
	const key = String(id || "").slice(0, 80);
	if (!key) return 0;
	const [res] = await pool.query(
		`UPDATE athena_notification SET acknowledged_at = UTC_TIMESTAMP(3), acknowledged_via = ?
		 WHERE profile_id = ? AND acknowledged_at IS NULL AND (uuid = ? OR source_uuid = ?)`,
		[via, profileId, key, key]
	);
	return res?.affectedRows || 0;
}

async function acknowledgeAll(profileId) {
	const [res] = await pool.query(
		`UPDATE athena_notification SET acknowledged_at = UTC_TIMESTAMP(3), acknowledged_via = 'app'
		 WHERE profile_id = ? AND acknowledged_at IS NULL`,
		[profileId]
	);
	return res?.affectedRows || 0;
}

module.exports = { record, list, acknowledge, acknowledgeAll };
