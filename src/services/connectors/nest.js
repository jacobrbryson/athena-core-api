const pool = require("../../helpers/db");
const { providerGet } = require("./http");
const { DEFAULT_TZ } = require("../clock");

/**
 * Google Nest — the devices a person shared through Device Access, read
 * through the Smart Device Management API. Read-only: nothing here sets a
 * temperature or changes a mode, and there is no action that would.
 *
 * What makes this more than a live read is connectivity. "The downstairs
 * thermostat went offline at 2:14" is a transition, and a transition needs a
 * stored previous state, so each device's last-known state is kept in
 * athena_nest_device. Two writers move it, through the same transition():
 *
 *   recordEvent()  a Pub/Sub push from Google (controllers/nestWebhook.js) —
 *                  the normal path, seconds after the device changes.
 *   sync()         a full device list — at link time, when the person asks,
 *                  and at most hourly from the initiative trigger as the
 *                  backstop for a push that never arrived.
 *
 * The initiative trigger (initiative/triggers.js, nest_offline) reads only
 * the stored rows, so evaluating it costs no API call.
 */

const PROVIDER = "nest";
const LABEL = "Google Nest";
const HOUR = 3_600_000;
const STALE_MS = HOUR;

const T = {
	info: "sdm.devices.traits.Info",
	connectivity: "sdm.devices.traits.Connectivity",
	temperature: "sdm.devices.traits.Temperature",
	humidity: "sdm.devices.traits.Humidity",
	mode: "sdm.devices.traits.ThermostatMode",
	eco: "sdm.devices.traits.ThermostatEco",
	hvac: "sdm.devices.traits.ThermostatHvac",
	setpoint: "sdm.devices.traits.ThermostatTemperatureSetpoint",
	settings: "sdm.devices.traits.Settings",
};

const KEYWORDS =
	/\b(nest|thermostats?|hvac|furnace|heating|heat pump|air ?condition(?:ing|er)?|a\/c|house temperature|indoor temperature|temperature (?:inside|in the house|downstairs|upstairs)|humidity|offline)\b/i;

function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

function failure(message, status, code) {
	return Object.assign(new Error(message), { status, code });
}

/** The Device Access project every path is scoped to. */
function projectId() {
	const id = process.env.NEST_DEVICE_ACCESS_PROJECT_ID;
	if (typeof id !== "string" || !id.trim()) {
		throw failure("NEST_DEVICE_ACCESS_PROJECT_ID is not configured", 503, "nest_unconfigured");
	}
	return id.trim();
}

/** A device resource name inside OUR project, and nothing else. */
function isDeviceName(name, project = projectId()) {
	if (typeof name !== "string" || name.length > 255) return false;
	const prefix = `enterprises/${project}/devices/`;
	return name.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(name.slice(prefix.length));
}

/** "sdm.devices.types.THERMOSTAT" -> "thermostat". */
function typeLabel(type) {
	const tail = String(type || "").split(".").pop() || "device";
	return tail.toLowerCase().replace(/_/g, " ");
}

/** The parts of a trait map worth keeping; anything absent stays absent. */
function readingsOf(traits = {}) {
	const out = {};
	const temp = traits[T.temperature]?.ambientTemperatureCelsius;
	if (Number.isFinite(temp)) out.temperatureC = temp;
	const humidity = traits[T.humidity]?.ambientHumidityPercent;
	if (Number.isFinite(humidity)) out.humidityPercent = humidity;
	if (typeof traits[T.mode]?.mode === "string") out.mode = traits[T.mode].mode;
	if (typeof traits[T.eco]?.mode === "string") out.eco = traits[T.eco].mode;
	if (typeof traits[T.hvac]?.status === "string") out.hvac = traits[T.hvac].status;
	const sp = traits[T.setpoint];
	if (sp && typeof sp === "object") {
		if (Number.isFinite(sp.heatCelsius)) out.heatC = sp.heatCelsius;
		if (Number.isFinite(sp.coolCelsius)) out.coolC = sp.coolCelsius;
	}
	if (typeof traits[T.settings]?.temperatureScale === "string") out.scale = traits[T.settings].temperatureScale;
	return out;
}

function connectivityOf(traits = {}) {
	const status = traits[T.connectivity]?.status;
	return status === "ONLINE" || status === "OFFLINE" ? status : null;
}

/** One SDM device, flattened. */
function normalizeDevice(d) {
	const traits = d?.traits || {};
	const room = (d?.parentRelations || []).map((r) => r?.displayName).find(Boolean) || null;
	return {
		name: d?.name || null,
		type: typeLabel(d?.type),
		displayName: traits[T.info]?.customName || null,
		room,
		connectivity: connectivityOf(traits) || "UNKNOWN",
		readings: readingsOf(traits),
	};
}

/**
 * The single place connectivity moves.
 *
 * `offline_since` is set on the way INTO offline and kept while it stays
 * there — that instant is the occurrence the trigger dedupes on, so it must
 * not drift as further reports of "still offline" arrive. Coming back online
 * clears it. A report of the status it already has changes nothing.
 */
function transition(prev, status, at) {
	const before = {
		connectivity: prev?.connectivity || "UNKNOWN",
		offline_since: prev?.offline_since || null,
		online_since: prev?.online_since || null,
	};
	if (!status || status === before.connectivity) return before;
	if (status === "OFFLINE") return { connectivity: "OFFLINE", offline_since: at, online_since: before.online_since };
	return { connectivity: "ONLINE", offline_since: null, online_since: at };
}

function parseJson(value) {
	if (!value) return {};
	if (typeof value === "object") return value;
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Reading Google
// ---------------------------------------------------------------------------

/**
 * Every thermostat this person shared, live from SDM. Thermostats only:
 * cameras and doorbells can be shared on the same screen, but nothing here
 * has been built or described for them (docs/capabilities/nest.md).
 */
async function listDevices(profileId) {
	const data = await providerGet(profileId, PROVIDER, `/enterprises/${encodeURIComponent(projectId())}/devices`);
	return (data?.devices || [])
		.filter((d) => d?.type === "sdm.devices.types.THERMOSTAT")
		.map(normalizeDevice)
		.filter((d) => isDeviceName(d.name));
}

/**
 * Read the device list and bring the stored rows up to date with it.
 * Devices no longer shared are removed: they left the grant, and keeping
 * their last state would have her report on a thermostat she can't see.
 */
async function sync(profileId, { now = new Date() } = {}) {
	const devices = await listDevices(profileId);
	const [rows] = await pool.query(
		"SELECT device_name, connectivity, offline_since, online_since FROM athena_nest_device WHERE profile_id = ?",
		[profileId]
	);
	const byName = new Map(rows.map((r) => [r.device_name, r]));
	for (const d of devices) {
		const next = transition(byName.get(d.name), d.connectivity === "UNKNOWN" ? null : d.connectivity, now);
		await pool.query(
			`INSERT INTO athena_nest_device
				(profile_id, device_name, display_name, room, device_type, connectivity, offline_since, online_since, readings, event_at, synced_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), room = VALUES(room),
				device_type = VALUES(device_type), connectivity = VALUES(connectivity),
				offline_since = VALUES(offline_since), online_since = VALUES(online_since),
				readings = VALUES(readings), event_at = GREATEST(COALESCE(event_at, VALUES(event_at)), VALUES(event_at)),
				synced_at = VALUES(synced_at)`,
			[profileId, d.name, d.displayName, d.room, d.type, next.connectivity, next.offline_since, next.online_since,
				JSON.stringify(d.readings), now, now]
		);
	}
	const keep = devices.map((d) => d.name);
	await pool.query(
		keep.length
			? "DELETE FROM athena_nest_device WHERE profile_id = ? AND device_name NOT IN (?)"
			: "DELETE FROM athena_nest_device WHERE profile_id = ?",
		keep.length ? [profileId, keep] : [profileId]
	);
	return devices.length;
}

/** The hourly backstop: sync only when the stored rows are older than that. */
async function refreshIfStale(profileId, { now = new Date(), maxAgeMs = STALE_MS } = {}) {
	const [rows] = await pool.query(
		"SELECT MIN(synced_at) AS oldest, COUNT(*) AS n FROM athena_nest_device WHERE profile_id = ?",
		[profileId]
	);
	const oldest = rows[0]?.oldest ? new Date(rows[0].oldest).getTime() : 0;
	if (rows[0]?.n && now.getTime() - oldest < maxAgeMs) return false;
	await sync(profileId, { now });
	return true;
}

// ---------------------------------------------------------------------------
// Pub/Sub events
// ---------------------------------------------------------------------------

/** Profiles with a live Nest link — who to re-read when an unknown device appears. */
async function linkedProfiles() {
	const [rows] = await pool.query(
		"SELECT DISTINCT profile_id FROM user_credential WHERE provider = 'nest' AND status = 'active'"
	);
	return rows.map((r) => Number(r.profile_id));
}

/**
 * Apply one decoded SDM event. Returns which profiles saw a device go offline
 * (the webhook evaluates those right away) and which need a full re-read.
 *
 * Only devices already stored are updated: the stored row is what ties a
 * device to a person, and nothing in the event itself is trusted to say who
 * that is. An event for a device nobody has yet — or a relation change, a
 * device added or removed on Google's side — re-reads every linked profile,
 * which is cheap because it is rare.
 */
async function recordEvent(event, { project = projectId() } = {}) {
	const at = new Date(event?.timestamp);
	if (Number.isNaN(at.getTime())) return { applied: 0, wentOffline: [], resync: [] };

	if (event.relationUpdate) return { applied: 0, wentOffline: [], resync: await linkedProfiles() };

	const name = event.resourceUpdate?.name;
	const traits = event.resourceUpdate?.traits;
	if (!isDeviceName(name, project) || !traits || typeof traits !== "object") {
		return { applied: 0, wentOffline: [], resync: [] };
	}

	const [rows] = await pool.query(
		"SELECT id, profile_id, connectivity, offline_since, online_since, readings, event_at FROM athena_nest_device WHERE device_name = ?",
		[name]
	);
	if (!rows.length) return { applied: 0, wentOffline: [], resync: await linkedProfiles() };

	const status = connectivityOf(traits);
	const fresh = readingsOf(traits);
	const wentOffline = [];
	let applied = 0;
	for (const row of rows) {
		// Pub/Sub may redeliver or reorder. An event older than what this row
		// already reflects is dropped, so a device never moves backwards.
		if (row.event_at && new Date(row.event_at).getTime() > at.getTime()) continue;
		const next = transition(row, status, at);
		const [result] = await pool.query(
			`UPDATE athena_nest_device SET connectivity = ?, offline_since = ?, online_since = ?, readings = ?, event_at = ?
			 WHERE id = ? AND (event_at IS NULL OR event_at <= ?)`,
			[next.connectivity, next.offline_since, next.online_since,
				JSON.stringify({ ...parseJson(row.readings), ...fresh }), at, row.id, at]
		);
		if (!result.affectedRows) continue;
		applied += 1;
		if (next.connectivity === "OFFLINE" && row.connectivity !== "OFFLINE") wentOffline.push(Number(row.profile_id));
	}
	return { applied, wentOffline: [...new Set(wentOffline)], resync: [] };
}

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

function publicRow(r) {
	return {
		name: r.device_name,
		displayName: r.display_name || null,
		room: r.room || null,
		type: r.device_type || "device",
		connectivity: r.connectivity,
		offlineSince: r.offline_since ? new Date(r.offline_since).toISOString() : null,
		onlineSince: r.online_since ? new Date(r.online_since).toISOString() : null,
		readings: parseJson(r.readings),
	};
}

async function storedDevices(profileId) {
	const [rows] = await pool.query(
		`SELECT device_name, display_name, room, device_type, connectivity, offline_since, online_since, readings
		 FROM athena_nest_device WHERE profile_id = ? ORDER BY room, display_name, device_name`,
		[profileId]
	);
	return rows.map(publicRow);
}

async function offlineDevices(profileId) {
	return (await storedDevices(profileId)).filter((d) => d.connectivity === "OFFLINE" && d.offlineSince);
}

/** "Downstairs thermostat", "Hallway thermostat", or the custom name if one was given. */
function deviceTitle(d) {
	if (d.displayName) return d.displayName;
	return d.room ? `${d.room} ${d.type}` : `Nest ${d.type}`;
}

function clockTime(iso, timeZone = DEFAULT_TZ) {
	try {
		return new Intl.DateTimeFormat("en-US", {
			weekday: "short", hour: "numeric", minute: "2-digit", timeZone,
		}).format(new Date(iso));
	} catch {
		return iso;
	}
}

function temp(celsius, scale) {
	if (!Number.isFinite(celsius)) return null;
	return scale === "CELSIUS" ? `${Math.round(celsius * 10) / 10}°C` : `${Math.round((celsius * 9) / 5 + 32)}°F`;
}

function formatDevice(d) {
	const r = d.readings || {};
	const bits = [];
	if (d.connectivity === "OFFLINE") bits.push(`OFFLINE since ${clockTime(d.offlineSince)} (readings are from before that)`);
	else bits.push(d.connectivity === "ONLINE" ? "online" : "status unknown");
	const t = temp(r.temperatureC, r.scale);
	if (t) bits.push(`${t} inside`);
	if (Number.isFinite(r.humidityPercent)) bits.push(`humidity ${r.humidityPercent}%`);
	if (r.eco && r.eco !== "OFF") bits.push("eco mode");
	else if (r.mode) {
		const target = r.mode === "HEAT" ? temp(r.heatC, r.scale) : r.mode === "COOL" ? temp(r.coolC, r.scale)
			: r.mode === "HEATCOOL" ? [temp(r.heatC, r.scale), temp(r.coolC, r.scale)].filter(Boolean).join("–") : null;
		bits.push(`mode ${r.mode.toLowerCase()}${target ? ` set to ${target}` : ""}`);
	}
	if (r.hvac && r.hvac !== "OFF") bits.push(`currently ${r.hvac.toLowerCase()}`);
	return `- ${deviceTitle(d)} — ${bits.join(", ")}`;
}

/**
 * Grounding block for the prompt. Reads Google (which also refreshes the
 * stored rows) and falls back to the stored rows if Google is unreachable,
 * saying so — a stale reading presented as live is worse than none.
 */
async function buildContext(profileId) {
	let note = "";
	try {
		await sync(profileId);
	} catch (err) {
		if (err?.code === "not_connected") throw err;
		note = " (Google could not be reached just now; this is the last state I recorded)";
	}
	const devices = await storedDevices(profileId);
	if (!devices.length) return `Google Nest: no devices are shared with Athena${note}.`;
	return [`Google Nest devices${note}:`, ...devices.map(formatDevice)].join("\n");
}

// ---------------------------------------------------------------------------
// Gemini tools
// ---------------------------------------------------------------------------

const FUNCTION_DECLARATIONS = [
	{
		name: "get_nest_devices",
		description:
			"The person's Google Nest thermostats: whether each is online or offline (and since when), " +
			"indoor temperature, humidity, mode, set temperature and whether it is heating or cooling now. " +
			'Use for "is the downstairs thermostat online", "what temperature is it upstairs", or "is the heat on". ' +
			"Read-only — Athena cannot change a thermostat.",
		parameters: { type: "OBJECT", properties: {} },
	},
];

async function executeTool(name, _args = {}, { profileId }) {
	if (name !== "get_nest_devices") throw new Error(`Unknown Nest tool: ${name}`);
	let stale = false;
	try {
		await sync(profileId);
	} catch (err) {
		if (err?.code === "not_connected") throw err;
		stale = true;
	}
	return { devices: await storedDevices(profileId), ...(stale ? { note: "Google could not be reached; last recorded state." } : {}) };
}

module.exports = {
	PROVIDER,
	LABEL,
	matches,
	projectId,
	isDeviceName,
	normalizeDevice,
	readingsOf,
	transition,
	listDevices,
	sync,
	refreshIfStale,
	recordEvent,
	storedDevices,
	offlineDevices,
	deviceTitle,
	clockTime,
	formatDevice,
	buildContext,
	FUNCTION_DECLARATIONS,
	executeTool,
};
