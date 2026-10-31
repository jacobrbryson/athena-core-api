/**
 * Where Athena keeps voiceprints (migration 0108, owner 2026-10-31).
 *
 * Storage and comparison. Capture isn't here: a print must be computed on the
 * device, because only text ever leaves the phone. A print is
 * biometric data, so: it needs the consent record that allowed it, it is
 * encrypted at rest, reading one is for a matcher in code and never for a
 * prompt, and withdrawing consent deletes it outright. A match could only ever
 * suggest who is speaking; it can't approve anything.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");
const crypto = require("../../helpers/crypto");

function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

/** Save or replace a person's print for one model. `print` is any JSON value. */
async function saveVoiceprint({ familyId, actorId, model, print, sampleCount = 1, consentEventId }) {
	if (!consentEventId) throw failure("A voiceprint needs the agreement that allows it.", 403);
	if (!actorId || !model || print == null) throw failure("A voiceprint needs a person, a model and a print.");
	const encrypted = await crypto.encrypt(JSON.stringify(print));
	await pool.query(
		`INSERT INTO athena_gm_voiceprint (uuid, family_id, actor_id, model, print_enc, sample_count, consent_event_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE print_enc = VALUES(print_enc), sample_count = VALUES(sample_count), consent_event_id = VALUES(consent_event_id)`,
		[randomUUID(), familyId, actorId, String(model).slice(0, 80), encrypted, sampleCount, consentEventId]
	);
}

/** For a matcher in code only. Never put the result in a prompt. */
async function readVoiceprints(familyId, model) {
	const [rows] = await pool.query("SELECT actor_id, print_enc FROM athena_gm_voiceprint WHERE family_id = ? AND model = ?", [familyId, model]);
	const out = [];
	for (const row of rows) {
		try {
			out.push({ actorId: row.actor_id, print: JSON.parse(await crypto.decrypt(row.print_enc)) });
		} catch (err) {
			console.warn(`[guardian missions] unreadable voiceprint for actor ${row.actor_id}:`, err.message);
		}
	}
	return out;
}

/** Delete every print a person has. Called when they withdraw. */
async function forgetVoiceprints(familyId, actorId) {
	await pool.query("DELETE FROM athena_gm_voiceprint WHERE family_id = ? AND actor_id = ?", [familyId, actorId]);
}

const MIN_DIMENSIONS = 64;
const MAX_DIMENSIONS = 1024;
const MATCH_AT = 0.75;
const CLEAR_MARGIN = 0.05;

/** Pure: is this a usable print? */
function validPrint(print) {
	return Array.isArray(print) && print.length >= MIN_DIMENSIONS && print.length <= MAX_DIMENSIONS && print.every((n) => Number.isFinite(n));
}

/** Pure: how alike two prints are, from -1 to 1. Different lengths don't compare. */
function similarity(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
	let dot = 0;
	let left = 0;
	let right = 0;
	for (let i = 0; i < a.length; i += 1) {
		dot += a[i] * b[i];
		left += a[i] * a[i];
		right += b[i] * b[i];
	}
	return left && right ? dot / Math.sqrt(left * right) : 0;
}

/**
 * Pure: who this might be. A suggestion only: nobody unless one person is above
 * the bar and clearly ahead of the next, because guessing between siblings is
 * worse than saying it's not clear.
 */
function bestMatch(print, known) {
	const scored = known.map((k) => ({ actorId: k.actorId, score: similarity(print, k.print) })).sort((x, y) => y.score - x.score);
	const [first, second] = scored;
	if (!first || first.score < MATCH_AT) return null;
	if (second && first.score - second.score < CLEAR_MARGIN) return null;
	return first;
}

module.exports = { saveVoiceprint, readVoiceprints, forgetVoiceprints, validPrint, similarity, bestMatch };
