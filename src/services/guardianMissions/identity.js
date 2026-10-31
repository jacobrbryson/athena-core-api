/**
 * Who is on the other end of a channel (migration 0108).
 *
 * paired_device knows the account behind a phone, browser or number; this says
 * which Guardian or parent that is. The two questions it answers:
 *
 *   whoIs      this device or number → the person, or "not sure"
 *   reachFor   this person → the ways to reach them, best first
 *
 * What it hands back is plain labels ("Thomas's phone, by text"), never a
 * number or a token, so it is safe to put in front of a model. Numbers and
 * tokens stay encrypted in paired_device; only push reads them.
 *
 * Contact points follow paired_device: syncDevices opens one for each live
 * device and ends it when the device goes. A device on an account two people
 * use is 'shared', and whoIs then says who it might be, not who it is. Trust
 * only describes: nothing here approves anything.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");

const TRUST_ORDER = ["session", "paired", "number", "shared", "unverified"];
const THINGS = { android: "phone", car: "car", web: "browser", sms: "phone" };
const HOW = { push: "notification", sms: "text", email: "email", watch: "watch", walkie: "walkie-talkie", chat: "chat", voice: "voice" };
const REPLY_ROUTES = {
	push: { channel: "push", trust: "paired" },
	sms: { channel: "sms", trust: "number" },
	app: { channel: "chat", trust: "session" },
	voice: { channel: "voice", trust: "unverified" },
};

/** What a paired_device platform means as a channel. Unknown platforms aren't channels. */
function channelFor(platform) {
	if (platform === "sms") return { channel: "sms", trust: "number" };
	if (THINGS[platform]) return { channel: "push", trust: "paired" };
	return null;
}

/** "Thomas's phone, by text". */
function labelFor(name, { platform = null, channel }) {
	const thing = THINGS[platform];
	const how = HOW[channel] || channel;
	return thing ? `${name}'s ${thing}, by ${how}` : `${name}, by ${how}`;
}

/** Most trusted first; a tie keeps the order it came in. */
function rank(contacts) {
	return [...contacts].sort((a, b) => TRUST_ORDER.indexOf(a.trust) - TRUST_ORDER.indexOf(b.trust));
}

function shape(row) {
	return {
		uuid: row.uuid,
		channel: row.channel,
		trust: row.trust,
		label: labelFor(row.display_name, row),
		reachable: row.device_id == null ? null : row.reachable === 1,
	};
}

/**
 * Bring contact points in line with paired_device. Opens what is missing, ends
 * what has gone, and marks a device shared once two people sit on its account.
 */
async function syncDevices(familyId) {
	const [actors] = await pool.query("SELECT id, profile_id FROM athena_gm_actor WHERE family_id = ? AND kind IN ('parent','kid') AND profile_id IS NOT NULL", [familyId]);
	if (!actors.length) return;
	const owners = new Map();
	for (const a of actors) owners.set(String(a.profile_id), [...(owners.get(String(a.profile_id)) || []), a]);
	const [devices] = await pool.query(
		"SELECT id, name, platform, profile_id FROM paired_device WHERE profile_id IN (?) AND token_hash IS NOT NULL AND revoked_at IS NULL",
		[[...owners.keys()]]
	);
	const [open] = await pool.query("SELECT id, actor_id, device_id, trust FROM athena_gm_contact_point WHERE family_id = ? AND valid_to IS NULL AND device_id IS NOT NULL", [familyId]);

	const wanted = new Set();
	for (const device of devices) {
		const route = channelFor(device.platform);
		if (!route) continue;
		const people = owners.get(String(device.profile_id)) || [];
		const trust = people.length > 1 ? "shared" : route.trust;
		for (const person of people) {
			wanted.add(`${person.id}:${device.id}`);
			const existing = open.find((c) => Number(c.actor_id) === Number(person.id) && Number(c.device_id) === Number(device.id));
			if (!existing) {
				await pool.query(
					`INSERT IGNORE INTO athena_gm_contact_point (uuid, family_id, actor_id, channel, device_id, name, trust, verified_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
					[randomUUID(), familyId, person.id, route.channel, device.id, device.name, trust]
				);
			} else if (existing.trust !== trust) {
				await pool.query("UPDATE athena_gm_contact_point SET trust = ? WHERE id = ?", [trust, existing.id]);
			}
		}
	}
	for (const c of open) {
		if (!wanted.has(`${c.actor_id}:${c.device_id}`)) {
			await pool.query("UPDATE athena_gm_contact_point SET valid_to = NOW() WHERE id = ?", [c.id]);
		}
	}
}

const CURRENT = `SELECT c.id, c.uuid, c.actor_id, c.channel, c.device_id, c.trust, a.uuid AS actor_uuid, a.display_name, a.kind, d.platform, d.uuid AS device_uuid,
		(d.push_token_enc IS NOT NULL AND d.push_provider IS NOT NULL) AS reachable
	 FROM athena_gm_contact_point c
	 JOIN athena_gm_actor a ON a.id = c.actor_id
	 LEFT JOIN paired_device d ON d.id = c.device_id
	 WHERE c.valid_to IS NULL`;

/** Every person's current ways to reach them, best first, keyed by actor id. */
async function contactsByActor(familyId) {
	await syncDevices(familyId);
	const [rows] = await pool.query(`${CURRENT} AND c.family_id = ?`, [familyId]);
	const byActor = {};
	for (const row of rows) (byActor[row.actor_id] ||= []).push(shape(row));
	const [guardians] = await pool.query("SELECT id, display_name FROM athena_gm_actor WHERE family_id = ? AND guardian_credential_id IS NOT NULL", [familyId]);
	for (const g of guardians) (byActor[g.id] ||= []).push({ uuid: null, channel: "chat", trust: "session", label: `${g.display_name}, in the Guardians app`, reachable: true });
	for (const id of Object.keys(byActor)) byActor[id] = rank(byActor[id]);
	return byActor;
}

/** One person's current ways to reach them, best first. */
async function reachFor(familyId, actorId) {
	return (await contactsByActor(familyId))[actorId] || [];
}

/**
 * Who a device belongs to. known: false means no Guardian or parent. A shared
 * device gives person: null and the people it might be, because a device is not
 * a person.
 */
async function whoIs({ deviceId, channel }) {
	const unknown = { known: false, person: null, candidates: [], label: null, trust: null };
	if (!deviceId) return unknown;
	const [families] = await pool.query(
		"SELECT DISTINCT a.family_id FROM athena_gm_actor a JOIN paired_device d ON d.profile_id = a.profile_id WHERE d.id = ? AND a.kind IN ('parent','kid')",
		[deviceId]
	);
	for (const f of families) await syncDevices(f.family_id);
	const [rows] = await pool.query(`${CURRENT} AND c.device_id = ? AND c.channel = ?`, [deviceId, channel]);
	if (!rows.length) return unknown;
	const candidates = rows.map((r) => ({ uuid: r.actor_uuid, name: r.display_name, kind: r.kind }));
	const single = rows.length === 1 && rows[0].trust !== "shared";
	return {
		known: true,
		person: single ? candidates[0] : null,
		candidates,
		label: single ? labelFor(rows[0].display_name, rows[0]) : `A shared ${THINGS[rows[0].platform] || "device"}, by ${HOW[channel] || channel}`,
		trust: rows[0].trust,
		actorId: single ? rows[0].actor_id : null,
		contactPointId: single ? rows[0].id : null,
		familyId: families[0]?.family_id ?? null,
	};
}

/** Who a phone number belongs to. The number itself goes no further than push. */
async function whoIsNumber(phone) {
	const owner = await require("../push").profileForNumber(phone);
	return whoIs({ deviceId: owner?.deviceId, channel: "sms" });
}

/** Append-only. Never throws: the record must not undo the message. */
async function recordContact({ familyId, actorId = null, contactPointId = null, direction, channel, trust = "unverified", outcome, missionId = null, stepId = null, reason = null }) {
	try {
		await pool.query(
			`INSERT INTO athena_gm_contact_event (family_id, actor_id, contact_point_id, direction, channel, trust, outcome, mission_id, step_id, reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[familyId, actorId, contactPointId, direction, channel, trust, outcome, missionId, stepId, reason ? String(reason).slice(0, 160) : null]
		);
	} catch (err) {
		console.warn("[guardian missions] contact not recorded:", err.message);
	}
}

/**
 * Record a mission ask against the devices push reported on: one event per
 * device, or one failure when nothing was attempted. Never throws.
 */
async function recordDelivery(familyId, actor, step, result) {
	const base = { familyId, actorId: actor?.id ?? null, direction: "out", missionId: step.mission_id, stepId: step.id };
	const attempts = result?.results || [];
	if (!attempts.length) return recordContact({ ...base, channel: "push", outcome: "failed", reason: result?.skipped || "nothing was sent" });
	let rows = [];
	try {
		[rows] = await pool.query(`${CURRENT} AND c.actor_id = ?`, [actor?.id ?? 0]);
	} catch (err) {
		console.warn("[guardian missions] contact points unavailable:", err.message);
	}
	for (const attempt of attempts) {
		const contact = rows.find((r) => r.device_uuid === attempt.uuid);
		await recordContact({
			...base,
			contactPointId: contact?.id ?? null,
			channel: contact?.channel || attempt.channel || channelFor(attempt.platform)?.channel || "push",
			trust: contact?.trust || "unverified",
			outcome: attempt.ok ? "sent" : "failed",
			reason: attempt.reason,
		});
	}
}

/** A mission reply came in from a person the request already proved. */
function recordReply({ familyId, actorId, via, missionId, stepId }) {
	const route = REPLY_ROUTES[via] || REPLY_ROUTES.app;
	return recordContact({ familyId, actorId, direction: "in", channel: route.channel, trust: route.trust, outcome: "received", missionId, stepId });
}

/** An inbound text from a registered number. Only Guardians and parents are recorded. */
async function recordInboundText(deviceId) {
	try {
		const who = await whoIs({ deviceId, channel: "sms" });
		if (!who.known || !who.familyId) return who;
		await recordContact({ familyId: who.familyId, actorId: who.actorId, contactPointId: who.contactPointId, direction: "in", channel: "sms", trust: who.trust, outcome: "received" });
		return who;
	} catch (err) {
		console.warn("[guardian missions] inbound text not recorded:", err.message);
		return null;
	}
}

module.exports = { channelFor, labelFor, rank, syncDevices, contactsByActor, reachFor, whoIs, whoIsNumber, recordContact, recordDelivery, recordReply, recordInboundText };
