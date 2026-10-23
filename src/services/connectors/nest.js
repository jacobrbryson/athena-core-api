const pool = require("../../helpers/db");
const { providerGet, providerRequest } = require("./http");
const { DEFAULT_TZ } = require("../clock");
const history = require("../nestHistory");

/**
 * Google Nest — the devices a person shared through Device Access, read
 * through the Smart Device Management API. Reads are free; the one write,
 * executeCommands(), is reachable only from the set_thermostat action after
 * a person approved its card (services/actions/registry.js).
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
 *
 * Both writers also hand the readings to nestHistory.record(), which keeps a
 * thinned history (athena_nest_reading) for the sleep and heating checks.
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
 * Is it actually reporting? Google can go on listing a thermostat as ONLINE
 * after it has stopped sending anything, and what it hands back then is
 * exactly 0 °C and exactly 0 % humidity (seen on the owner's Den thermostat,
 * 2026-10-16). Together those are a placeholder, not a measurement: no room a
 * thermostat sits in is at freezing with bone-dry air. So, on the owner's
 * instruction, that pair counts as offline — shown as "not reporting" rather
 * than as Google's word "offline", because Google said the opposite.
 *
 * Returns the status to feed transition() and the readings to store, which
 * keep Google's own flag (`google`) beside the `notReporting` marker. A device
 * that starts reporting again goes back to whatever Google last said.
 */
function assess(readings, googleStatus, prevReadings = {}) {
	const r = { ...readings };
	if (googleStatus) r.google = googleStatus;
	else if (prevReadings.google && !r.google) r.google = prevReadings.google;
	r.notReporting = r.temperatureC === 0 && r.humidityPercent === 0;
	if (r.notReporting) return { status: "OFFLINE", readings: r };
	return { status: r.google || (prevReadings.notReporting ? "ONLINE" : null), readings: r };
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
		"SELECT device_name, connectivity, offline_since, online_since, readings FROM athena_nest_device WHERE profile_id = ?",
		[profileId]
	);
	const byName = new Map(rows.map((r) => [r.device_name, r]));
	for (const d of devices) {
		const prev = byName.get(d.name);
		const seen = assess(d.readings, d.connectivity === "UNKNOWN" ? null : d.connectivity, parseJson(prev?.readings));
		const next = transition(prev, seen.status, now);
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
				JSON.stringify(seen.readings), now, now]
		);
		await history.record(profileId, d.name, seen.readings, now);
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
// Writing — only ever from the action layer
// ---------------------------------------------------------------------------

/**
 * The SDM commands this module will send, and nothing else. The only caller
 * is the set_thermostat action's execute(), after a person approved the card;
 * its normalize() is what decided the values. Kept as an allowlist here too so
 * this function cannot be pointed at a command nobody vouched for.
 */
const COMMANDS = new Set([
	"sdm.devices.commands.ThermostatEco.SetMode",
	"sdm.devices.commands.ThermostatMode.SetMode",
	"sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat",
	"sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool",
	"sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange",
]);

/**
 * Send commands to one of this person's own thermostats, in order, stopping
 * at the first refusal. Order matters: eco must be off before a setpoint will
 * take, and the mode must be set before the setpoint that belongs to it.
 * Afterwards the stored state is re-read so the panel and chat show the result.
 */
async function executeCommands(profileId, deviceName, commands) {
	if (!isDeviceName(deviceName)) throw failure("Not a Nest device in this project", 400, "bad_device");
	const [own] = await pool.query(
		"SELECT 1 FROM athena_nest_device WHERE profile_id = ? AND device_name = ? LIMIT 1",
		[profileId, deviceName]
	);
	if (!own.length) throw failure("That thermostat is no longer shared with Athena", 404, "not_shared");
	for (const c of commands) {
		if (!COMMANDS.has(c?.command)) throw failure("Unsupported Nest command", 400, "bad_command");
		await providerRequest(profileId, PROVIDER, `/${deviceName}:executeCommand`, {
			method: "POST",
			body: { command: c.command, params: c.params || {} },
			// A refused command is about the device or the values, not the grant.
			invalidateOnAuthFailure: false,
		});
	}
	await sync(profileId).catch((err) => console.warn("[nest] re-read after command failed:", err.message));
	return commands.length;
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

	const googleStatus = connectivityOf(traits);
	const fresh = readingsOf(traits);
	const wentOffline = [];
	let applied = 0;
	for (const row of rows) {
		// Pub/Sub may redeliver or reorder. An event older than what this row
		// already reflects is dropped, so a device never moves backwards.
		if (row.event_at && new Date(row.event_at).getTime() > at.getTime()) continue;
		const before = parseJson(row.readings);
		const seen = assess({ ...before, ...fresh }, googleStatus, before);
		const next = transition(row, seen.status, at);
		const [result] = await pool.query(
			`UPDATE athena_nest_device SET connectivity = ?, offline_since = ?, online_since = ?, readings = ?, event_at = ?
			 WHERE id = ? AND (event_at IS NULL OR event_at <= ?)`,
			[next.connectivity, next.offline_since, next.online_since,
				JSON.stringify(seen.readings), at, row.id, at]
		);
		if (!result.affectedRows) continue;
		applied += 1;
		await history.record(Number(row.profile_id), name, seen.readings, at);
		if (next.connectivity === "OFFLINE" && row.connectivity !== "OFFLINE") wentOffline.push(Number(row.profile_id));
	}
	return { applied, wentOffline: [...new Set(wentOffline)], resync: [] };
}

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

function publicRow(r) {
	const readings = parseJson(r.readings);
	// Offline by our reading, not Google's: it is listed online but sends
	// nothing (see assess). Said as "not reporting", never as "offline", and its
	// placeholder 0 °C / 0 % never leave here, so nothing can quote them.
	const notReporting = r.connectivity === "OFFLINE" && readings.notReporting === true && readings.google !== "OFFLINE";
	if (notReporting) {
		delete readings.temperatureC;
		delete readings.humidityPercent;
	}
	return {
		name: r.device_name,
		displayName: r.display_name || null,
		room: r.room || null,
		type: r.device_type || "device",
		connectivity: r.connectivity,
		offlineSince: r.offline_since ? new Date(r.offline_since).toISOString() : null,
		onlineSince: r.online_since ? new Date(r.online_since).toISOString() : null,
		readings,
		notReporting,
		sleepDevice: Boolean(Number(r.sleep_device)),
	};
}

async function storedDevices(profileId) {
	const [rows] = await pool.query(
		`SELECT device_name, display_name, room, device_type, connectivity, offline_since, online_since, readings, sleep_device
		 FROM athena_nest_device WHERE profile_id = ? ORDER BY room, display_name, device_name`,
		[profileId]
	);
	return rows.map(publicRow);
}

/**
 * Mark the one thermostat a person sleeps near (or none, with null). Only
 * their own stored device can be chosen; the rest are cleared in the same
 * statement so there is never more than one.
 */
async function setSleepDevice(profileId, deviceName) {
	if (deviceName !== null && !isDeviceName(deviceName)) throw failure("Not a Nest device in this project", 400, "bad_device");
	if (deviceName !== null) {
		const [own] = await pool.query(
			"SELECT 1 FROM athena_nest_device WHERE profile_id = ? AND device_name = ? LIMIT 1",
			[profileId, deviceName]
		);
		if (!own.length) throw failure("That thermostat is no longer shared with Athena", 404, "not_shared");
	}
	await pool.query(
		"UPDATE athena_nest_device SET sleep_device = (device_name = ?) WHERE profile_id = ?",
		[deviceName ?? "", profileId]
	);
	return true;
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
	if (d.notReporting) bits.push(`NOT REPORTING since ${clockTime(d.offlineSince)} — Google lists it as online, but it is sending no readings (its 0° and 0% humidity are placeholders, not measurements; never quote them as the temperature)`);
	else if (d.connectivity === "OFFLINE") bits.push(`OFFLINE since ${clockTime(d.offlineSince)} (readings are from before that)`);
	else bits.push(d.connectivity === "ONLINE" ? "online" : "status unknown");
	const t = d.notReporting ? null : temp(r.temperatureC, r.scale);
	if (t) bits.push(`${t} inside`);
	if (!d.notReporting && Number.isFinite(r.humidityPercent)) bits.push(`humidity ${r.humidityPercent}%`);
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
	const lines = [`Google Nest devices${note}:`, ...devices.map(formatDevice)];
	// Required here, not at the top: these two read this module.
	const bedroom = await require("../sleepClimate").promptLine(profileId);
	if (bedroom) lines.push(bedroom);
	const heating = await require("../hvacHealth").promptLine(profileId);
	if (heating) lines.push(heating);
	return lines.join("\n");
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
			"Reading only; to change a thermostat, propose the set_thermostat action.",
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
	assess,
	listDevices,
	sync,
	refreshIfStale,
	recordEvent,
	executeCommands,
	COMMANDS,
	storedDevices,
	offlineDevices,
	setSleepDevice,
	deviceTitle,
	clockTime,
	formatDevice,
	buildContext,
	FUNCTION_DECLARATIONS,
	executeTool,
};
