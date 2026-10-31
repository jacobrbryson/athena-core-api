/**
 * Where Athena keeps voiceprints (migration 0108, owner 2026-10-31).
 *
 * Storage only. Nothing captures a voice or compares two yet. A print is
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

module.exports = { saveVoiceprint, readVoiceprints, forgetVoiceprints };
