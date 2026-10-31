/**
 * Handing off approvals (migration 0114, owner 2026-10-31).
 *
 * A template is a kind of mission the owner approved once, with limits: which
 * tools, which people, which zones, how long. A draft inside every limit can be
 * started by any adult in the family, recorded in the action layer as their own
 * click, without the owner reviewing that mission. Nothing starts by itself, a
 * model can't start one, and Go and preflight still apply.
 *
 * Templates are off unless GM_TEMPLATES_ENABLED=on, and a template can be
 * retired at any time. A tool needing a parent's approval each time can't go in
 * one: a template never relaxes a per-call approval.
 *
 * A zone is an area an adult approved for kids to scout on their own. A kid's
 * scouting step needs one, with what's off limits said up front.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");
const geo = require("./geo");
const missions = require("./index");

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 18;
const GPS_SLACK_MAX_M = 50;
const TZ = process.env.DEFAULT_TZ || "America/New_York";

function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

const parse = (v) => {
	if (v == null || typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
};

const enabled = () => process.env.GM_TEMPLATES_ENABLED === "on";
const text = (v, max) => String(v ?? "").trim().slice(0, max);

/** Pure: is it daytime where the family is? */
function isDaylight(now = new Date(), tz = TZ) {
	const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(now));
	return hour >= DAY_START_HOUR && hour < DAY_END_HOUR;
}

/** Pure: is this reading inside the zone? GPS is forgiven only up to a limit. */
function insideZone(zone, { lat, lng, accuracy = 0 }) {
	if (zone.lat == null || zone.lng == null || !zone.radius_m) return true;
	if (lat == null || lng == null) return false;
	const distance = geo.distanceM({ lat: Number(zone.lat), lng: Number(zone.lng) }, { lat, lng });
	return distance <= Number(zone.radius_m) + Math.min(Number(accuracy) || 0, GPS_SLACK_MAX_M);
}

/** Pure: does this draft stay inside every limit? Returns the reasons it doesn't. */
function outsideLimits({ plan, capabilityKeys, wishes = 0, reach = 1 }, template) {
	const reasons = [];
	const allowedCaps = parse(template.capability_keys) || [];
	const allowedPeople = parse(template.actor_keys) || [];
	const allowedZones = parse(template.zone_uuids) || [];
	for (const key of capabilityKeys) {
		if (!allowedCaps.includes(key)) reasons.push(`${key} isn't in this template.`);
	}
	for (const person of new Set((plan?.steps || []).map((s) => s.actor))) {
		if (!allowedPeople.includes(person)) reasons.push(`${person} isn't in this template.`);
	}
	if (plan?.zone && !allowedZones.includes(plan.zone)) reasons.push("Its zone isn't in this template.");
	const minutes = (plan?.steps || []).reduce((n, s) => n + (Number(s.dueMinutes) || 0), 0);
	if (minutes > Number(template.max_minutes)) reasons.push(`It could run ${minutes} minutes, and this template allows ${template.max_minutes}.`);
	if (wishes > 0) reasons.push("It needs something that hasn't been built.");
	if (Number(reach) > 1) reasons.push("It reaches beyond the household.");
	return reasons;
}

async function zoneByUuid(familyId, uuid) {
	const [rows] = await pool.query("SELECT * FROM athena_gm_zone WHERE family_id = ? AND uuid = ? AND retired_at IS NULL LIMIT 1", [familyId, uuid]);
	return rows[0] || null;
}

async function createZone(familyId, input, adult) {
	const name = text(input?.name, 120);
	const offLimits = text(input?.offLimits, 300);
	if (name.length < 2) throw failure("A zone needs a name.");
	if (offLimits.length < 3) throw failure("Say what's off limits.");
	const lat = input?.lat == null ? null : Number(input.lat);
	const lng = input?.lng == null ? null : Number(input.lng);
	const radius = input?.radiusM == null ? null : Number(input.radiusM);
	if ((lat == null) !== (lng == null) || (lat != null && (!Number.isFinite(lat) || !Number.isFinite(lng) || !(radius > 0)))) throw failure("A location needs a point and a radius.");
	const minutes = Number(input?.maxMinutes) || 60;
	if (minutes < 5 || minutes > 240) throw failure("Time limit must be 5 to 240 minutes.");
	const uuid = randomUUID();
	await pool.query(
		`INSERT INTO athena_gm_zone (uuid, family_id, name, off_limits, lat, lng, radius_m, daylight_only, max_minutes, created_by_actor_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[uuid, familyId, name, offLimits, lat, lng, radius, input?.daylightOnly === false ? 0 : 1, minutes, adult.id]
	);
	await missions.log(familyId, "zone_created", { actorId: adult.id, detail: { uuid, name } });
	return uuid;
}

async function retireZone(familyId, uuid, adult) {
	const [result] = await pool.query("UPDATE athena_gm_zone SET retired_at = NOW() WHERE family_id = ? AND uuid = ? AND retired_at IS NULL", [familyId, uuid]);
	if (!result.affectedRows) throw failure("Unknown zone.", 404);
	await missions.log(familyId, "zone_retired", { actorId: adult.id, detail: { uuid } });
}

/** Checks a template before the owner's click is recorded. Only known keys survive. */
async function normalizeTemplate(raw, owner) {
	const familyId = owner.family_id;
	const name = text(raw?.name, 120);
	if (name.length < 3) throw failure("A template needs a name.");
	const capabilityKeys = [...new Set(Array.isArray(raw?.capabilities) ? raw.capabilities : [])];
	const actorKeys = [...new Set(Array.isArray(raw?.people) ? raw.people : [])];
	const zoneUuids = [...new Set(Array.isArray(raw?.zones) ? raw.zones : [])];
	const maxMinutes = Number(raw?.maxMinutes);
	if (!capabilityKeys.length || !actorKeys.length) throw failure("A template needs tools and people.");
	if (!(maxMinutes >= 5 && maxMinutes <= 480)) throw failure("Time limit must be 5 to 480 minutes.");
	for (const key of capabilityKeys) {
		const cap = await missions.capabilityByKey(familyId, key);
		if (!cap || cap.kind !== "system") throw failure(`${key} isn't one of this family's tools.`);
		if (cap.permission !== "free") throw failure(`${cap.name} needs a parent's approval each time, so it can't go in a template.`);
	}
	for (const key of actorKeys) {
		if (!(await missions.actorByKey(familyId, key))) throw failure(`${key} isn't in this family.`);
	}
	for (const uuid of zoneUuids) {
		if (!(await zoneByUuid(familyId, uuid))) throw failure("One of those zones doesn't exist.");
	}
	return { family_id: Number(familyId), by: owner.id, name, capabilityKeys, actorKeys, zoneUuids, maxMinutes };
}

async function createTemplate(params, actionUuid) {
	const uuid = randomUUID();
	await pool.query(
		`INSERT INTO athena_gm_template (uuid, family_id, name, capability_keys, actor_keys, zone_uuids, max_minutes, approval_action_uuid, created_by_actor_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[uuid, params.family_id, params.name, JSON.stringify(params.capabilityKeys), JSON.stringify(params.actorKeys), JSON.stringify(params.zoneUuids), params.maxMinutes, actionUuid, params.by]
	);
	await missions.log(params.family_id, "template_created", { actorId: params.by, detail: { uuid, name: params.name } });
	return uuid;
}

async function retireTemplate(familyId, uuid, adult) {
	const [result] = await pool.query("UPDATE athena_gm_template SET retired_at = NOW() WHERE family_id = ? AND uuid = ? AND retired_at IS NULL", [familyId, uuid]);
	if (!result.affectedRows) throw failure("Unknown template.", 404);
	await missions.log(familyId, "template_retired", { actorId: adult.id, detail: { uuid } });
}

async function activeTemplates(familyId) {
	const [rows] = await pool.query("SELECT * FROM athena_gm_template WHERE family_id = ? AND retired_at IS NULL ORDER BY id DESC", [familyId]);
	return rows;
}

/** The first template this waiting draft fits, if templates are on. */
async function fitFor(mission) {
	if (!enabled() || mission.status !== "proposed") return null;
	const [caps] = mission.capabilityIds.length ? await pool.query("SELECT cap_key FROM athena_gm_capability WHERE id IN (?)", [mission.capabilityIds]) : [[]];
	const [[{ wishes }]] = await pool.query("SELECT COUNT(*) AS wishes FROM athena_gm_wish WHERE mission_id = ? AND status = 'wanted'", [mission.id]);
	const draft = { plan: parse(mission.plan), capabilityKeys: caps.map((c) => c.cap_key), wishes: Number(wishes), reach: mission.reach_rung };
	return (await activeTemplates(mission.family_id)).find((t) => !outsideLimits(draft, t).length) || null;
}

/** Mark a mission as started under a template. Called from the action's execute(). */
async function recordStart(familyId, missionUuid, templateUuid) {
	await pool.query(
		`UPDATE athena_gm_mission m JOIN athena_gm_template t ON t.uuid = ? AND t.family_id = m.family_id
		 SET m.template_id = t.id WHERE m.family_id = ? AND m.uuid = ?`,
		[templateUuid, familyId, missionUuid]
	);
}

/** Zones and templates for the page. */
async function overview(familyId, viewer) {
	const [[zones], templates] = await Promise.all([
		pool.query("SELECT uuid, name, off_limits, daylight_only, max_minutes, lat, radius_m FROM athena_gm_zone WHERE family_id = ? AND retired_at IS NULL ORDER BY name", [familyId]),
		activeTemplates(familyId),
	]);
	return {
		enabled: enabled(),
		canCreate: viewer?.can_create_templates === 1,
		zones: zones.map((z) => ({ uuid: z.uuid, name: z.name, offLimits: z.off_limits, daylightOnly: z.daylight_only === 1, maxMinutes: z.max_minutes, mapped: z.lat != null, radiusM: z.radius_m })),
		templates: templates.map((t) => ({ uuid: t.uuid, name: t.name, capabilities: parse(t.capability_keys) || [], people: parse(t.actor_keys) || [], zones: parse(t.zone_uuids) || [], maxMinutes: t.max_minutes })),
	};
}

module.exports = { enabled, isDaylight, insideZone, outsideLimits, zoneByUuid, createZone, retireZone, normalizeTemplate, createTemplate, retireTemplate, fitFor, recordStart, overview };
