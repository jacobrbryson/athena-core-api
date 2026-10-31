/**
 * The owner's switches (migration 0115). The environment variable still forces
 * one on, for a deployment that wants it. A read failure counts as off.
 *
 * Chat consent can't be turned on while a Guardian login has no family set up,
 * because that Guardian would be cut off with no way to agree.
 */
const pool = require("../../helpers/db");

const ENV = { templates: "GM_TEMPLATES_ENABLED", chat_consent: "GM_CONSENT_ENFORCED" };

function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

async function isOn(key) {
	if (process.env[ENV[key]] === "on") return true;
	try {
		const [rows] = await pool.query("SELECT enabled FROM athena_gm_setting WHERE setting_key = ? LIMIT 1", [key]);
		return rows[0]?.enabled === 1;
	} catch {
		return false;
	}
}

/** Active Guardian logins with no actor, who couldn't agree if chat consent were on. */
async function guardiansNotSetUp() {
	const [[row]] = await pool.query(
		`SELECT COUNT(*) AS n FROM guardian_credential g
		 LEFT JOIN athena_gm_actor a ON a.guardian_credential_id = g.id
		 WHERE g.is_active = 1 AND g.participant_type = 'guardian' AND g.adventure_key <> 'companion' AND a.id IS NULL`
	);
	return Number(row.n);
}

/** Only someone flagged to create templates can flip a switch. */
async function setSwitch(key, on, actor) {
	if (actor?.can_create_templates !== 1) throw failure("Only the owner can change this.", 403);
	if (!(key in ENV)) throw failure("Unknown switch.");
	if (key === "chat_consent" && on) {
		const waiting = await guardiansNotSetUp();
		if (waiting) throw failure(`${waiting} Guardian${waiting === 1 ? " isn't" : "s aren't"} set up yet and would lose chat with no way to agree.`, 409);
	}
	await pool.query(
		"INSERT INTO athena_gm_setting (setting_key, enabled, updated_by_actor_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_by_actor_id = VALUES(updated_by_actor_id)",
		[key, on ? 1 : 0, actor.id]
	);
}

module.exports = { isOn, guardiansNotSetUp, setSwitch };
