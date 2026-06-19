const pool = require("../helpers/db");

/**
 * Conversation mode catalog (Phase 5).
 *
 * Modes are data, not hardcoded. New modes (Quest, Coach, Lake Norman
 * Guardians, ...) are added by inserting rows into `conversation_mode`
 * and supplying a prompt strategy in controllers/prompt.js — no schema or
 * client changes required to register a mode.
 */

let cache = null;
let cacheAt = 0;
const TTL_MS = 60 * 1000;

async function listModes({ includeInactive = false } = {}) {
	const now = Date.now();
	if (!cache || now - cacheAt > TTL_MS) {
		const [rows] = await pool.query(
			`SELECT mode_key, label, description, is_active, sort_order
       FROM conversation_mode ORDER BY sort_order ASC, mode_key ASC;`
		);
		cache = rows;
		cacheAt = now;
	}
	return cache
		.filter((m) => includeInactive || m.is_active)
		.map((m) => ({
			key: m.mode_key,
			label: m.label,
			description: m.description,
			is_active: Boolean(m.is_active),
		}));
}

async function isValidMode(modeKey) {
	if (typeof modeKey !== "string" || !modeKey.trim()) return false;
	const modes = await listModes({ includeInactive: false });
	return modes.some((m) => m.key === modeKey.trim());
}

/** Resolve a requested mode to a safe, active mode key (defaults to 'teach'). */
async function resolveMode(modeKey) {
	return (await isValidMode(modeKey)) ? modeKey.trim() : "teach";
}

module.exports = { listModes, isValidMode, resolveMode };
