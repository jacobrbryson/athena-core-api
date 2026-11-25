/**
 * Secret messages in Signal Relay (owner, 2026-11-25). A person taps a short
 * message in Morse code and sends it to anyone else with Athena access; the
 * recipient decodes it in the game. Owner's choices: any person with an Athena
 * account can be a recipient, every message is logged (athena_relay_message,
 * migration 0129), and no parent view reads the log yet.
 *
 * Who counts as "has an Athena account" is the same rule the access boundary
 * uses (security/access.js `allowed`): an active owner grant, or a verified
 * email that matches an active Guardian credential. This module only reads
 * those tables to list names; it never grants or changes access.
 *
 * Only a first name, last initial and picture of each person leave here.
 */
const crypto = require("node:crypto");
const pool = require("../helpers/db");

const MAX_BODY = 30;
const MAX_PER_POST = 20;
const MAX_AGE_DAYS = 30;
/** Plenty for a game; stops a stuck key or a loop flooding someone's inbox. */
const MAX_SENT_PER_DAY = 200;
const INBOX_LIMIT = 50;

/** Letters, digits and single spaces, upper-case, trimmed; null when nothing is left. */
function cleanBody(text) {
	if (typeof text !== "string") return null;
	const body = text.toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/ +/g, " ").trim().slice(0, MAX_BODY).trim();
	return body || null;
}

/** A queued send from the tablet, or null when it can't be one. */
function cleanSend(m, now = new Date()) {
	if (!m || typeof m !== "object") return null;
	const id = typeof m.id === "string" ? m.id.trim() : "";
	if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null;
	const to = typeof m.to === "string" ? m.to.trim() : "";
	if (!/^[0-9a-f-]{36}$/i.test(to)) return null;
	const body = cleanBody(m.body);
	if (!body) return null;
	const at = new Date(m.at);
	if (Number.isNaN(at.getTime()) || at.getTime() < now.getTime() - MAX_AGE_DAYS * 86_400_000) return null;
	return { id, to, body, tappedAt: new Date(Math.min(at.getTime(), now.getTime())) };
}

/** "Thomas B." from a full name. */
function shortName(full) {
	const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
	if (!parts.length) return "Someone";
	return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

const ACCESS_PROFILES = `
	SELECT p.id, p.uuid, p.full_name, p.picture FROM profile p
	WHERE p.google_id IS NOT NULL AND (
	  p.google_id IN (SELECT google_id FROM athena_access_grant WHERE revoked_at IS NULL)
	  OR p.google_id IN (
	    SELECT i.google_id FROM athena_access_identity i
	    JOIN guardian_credential g ON g.is_active = 1 AND g.participant_type = 'guardian'
	      AND LOWER(TRIM(g.email)) = i.verified_email COLLATE utf8mb4_unicode_ci
	    WHERE i.verified_email IS NOT NULL))`;

/** Everyone the caller can send to: every other person with Athena access. */
async function recipients(profileId) {
	const [rows] = await pool.query(`${ACCESS_PROFILES} AND p.id <> ? ORDER BY p.full_name`, [profileId]);
	return rows.map((r) => ({ uuid: r.uuid, name: shortName(r.full_name), picture: r.picture || null }));
}

/** Log and deliver queued sends. Ones already logged (same client id) are skipped. */
async function send(profileId, messages, now = new Date()) {
	const clean = (Array.isArray(messages) ? messages : []).slice(0, MAX_PER_POST).map((m) => cleanSend(m, now)).filter(Boolean);
	if (!clean.length) return { saved: 0, refused: 0 };
	const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM athena_relay_message WHERE from_profile_id = ? AND created_at >= NOW() - INTERVAL 1 DAY", [profileId]);
	const room = Math.max(0, MAX_SENT_PER_DAY - Number(n));
	const uuids = [...new Set(clean.map((m) => m.to))];
	// A recipient must be someone with access right now, and not the sender.
	const [people] = await pool.query(`${ACCESS_PROFILES} AND p.uuid IN (?) AND p.id <> ?`, [uuids, profileId]);
	const idFor = new Map(people.map((p) => [p.uuid, p.id]));
	const rows = clean.filter((m) => idFor.has(m.to)).slice(0, room)
		.map((m) => [crypto.randomUUID(), profileId, idFor.get(m.to), m.id, m.body, m.tappedAt]);
	if (!rows.length) return { saved: 0, refused: clean.length };
	const [res] = await pool.query(
		"INSERT IGNORE INTO athena_relay_message (uuid, from_profile_id, to_profile_id, client_id, body, tapped_at) VALUES ?",
		[rows]
	);
	return { saved: Number(res?.affectedRows) || 0, refused: clean.length - rows.length };
}

/** Messages waiting to be decoded, oldest first. Fetching one marks it delivered. */
async function inbox(profileId) {
	const [rows] = await pool.query(
		`SELECT m.uuid, m.body, m.created_at, p.full_name, p.picture FROM athena_relay_message m
		 JOIN profile p ON p.id = m.from_profile_id
		 WHERE m.to_profile_id = ? AND m.decoded_at IS NULL ORDER BY m.created_at LIMIT ?`,
		[profileId, INBOX_LIMIT]
	);
	if (rows.length) {
		await pool.query("UPDATE athena_relay_message SET delivered_at = NOW() WHERE to_profile_id = ? AND uuid IN (?) AND delivered_at IS NULL", [profileId, rows.map((r) => r.uuid)]);
	}
	return rows.map((r) => ({ uuid: r.uuid, body: r.body, from: shortName(r.full_name), picture: r.picture || null, at: r.created_at }));
}

/** The recipient finished decoding it. Only the recipient can mark their own message. */
async function decoded(profileId, uuid) {
	if (typeof uuid !== "string" || !/^[0-9a-f-]{36}$/i.test(uuid)) return { ok: false };
	const [res] = await pool.query("UPDATE athena_relay_message SET decoded_at = COALESCE(decoded_at, NOW()), delivered_at = COALESCE(delivered_at, NOW()) WHERE uuid = ? AND to_profile_id = ?", [uuid, profileId]);
	return { ok: Number(res?.affectedRows) > 0 };
}

module.exports = { recipients, send, inbox, decoded, cleanBody, cleanSend, shortName, MAX_BODY, MAX_SENT_PER_DAY };
