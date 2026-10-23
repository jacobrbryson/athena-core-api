const pool = require("../../helpers/db");
const credentials = require("../credentials");
const { getSecret } = require("../secrets");
const { getProvider } = require("./registry");

/**
 * Smartcar — read straight from the car (docs/capabilities/smartcar.md,
 * migration 0091): what it is and its VIN, the odometer, fuel or charge,
 * whether it's locked, and — only for a car the person turned it on for —
 * where it is.
 *
 * Smartcar v3: there is no per-person token. The app holds one application
 * token from its machine-to-machine client id and secret (appToken), and each
 * request names the person with `sc-user-id` — the user_id Connect returned,
 * kept encrypted as this person's credential (see the registry entry). A
 * person can only ever be read with their own stored id.
 *
 * Read-only by construction: nothing here sends a command. The latest
 * reading per car is kept in athena_smartcar_vehicle so chat and the Vehicles
 * tab don't wake the car on every question; it is re-read when older than
 * STALE_MS, and nightly.
 *
 * A car is tied to one of the person's Property → Vehicles entries by VIN (or
 * their choice), and a linked car's odometer keeps that entry's mileage
 * current — the reason the owner asked for this.
 */

const PROVIDER = "smartcar";
const LABEL = "Smartcar";
const STALE_MS = 6 * 3_600_000;
const KM_PER_MI = 1.609344;
const TIMEOUT_MS = 20_000;

const KEYWORDS =
	/\b(smartcar|odometer|mileage|miles on|gas tank|fuel|tank|charge level|battery level|range|locked|unlock(?:ed)?|lock(?:ed)? the car|where(?:'s| is) (?:my|the) (?:car|truck|bmw|suv|van)|my car|the car|bmw)\b/i;

function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

const isId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(id);
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

// ---------------------------------------------------------------------------
// The application token and the request
// ---------------------------------------------------------------------------

let cachedToken = null; // { value, expiresAt }

/** One application token for every person, refreshed a minute before it lapses (1 h). */
async function appToken({ fetchImpl = fetch, now = Date.now() } = {}) {
	if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.value;
	const [clientId, clientSecret] = await Promise.all([getSecret("SMARTCAR_CLIENT_ID"), getSecret("SMARTCAR_CLIENT_SECRET")]);
	if (!clientId || !clientSecret) throw fail("Smartcar is not configured on this server", 503, "provider_unconfigured");
	const res = await fetchImpl(getProvider(PROVIDER).tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId.trim(), client_secret: clientSecret.trim() }),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok || !body.access_token) throw fail(`Smartcar refused the application credentials (${res.status})`, 502, "provider_error");
	cachedToken = { value: body.access_token, expiresAt: now + (Number(body.expires_in) || 3600) * 1000 };
	return cachedToken.value;
}

/** This person's Smartcar user id, or a not_connected error the callers already handle. */
async function userIdOf(profileId) {
	const link = await credentials.get(profileId, PROVIDER, { actor: "athena" });
	if (!link?.accessToken) throw fail("Smartcar is not connected", 409, "not_connected");
	return link.accessToken;
}

/** GET a v3 path for one person. 404/422-style "the car can't say" answers come back as null. */
async function v3(profileId, path, { userId, fetchImpl = fetch } = {}) {
	const who = userId || (await userIdOf(profileId));
	const token = await appToken({ fetchImpl });
	const res = await fetchImpl(`${getProvider(PROVIDER).apiBase}${path}`, {
		headers: { Authorization: `Bearer ${token}`, "sc-user-id": who, Accept: "application/json" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (res.status === 401) {
		cachedToken = null;
		throw fail("Smartcar refused the request", 502, "provider_error");
	}
	if (res.status === 403) throw Object.assign(fail("Smartcar access for this account was removed", 409, "not_connected"), { reason: "revoked" });
	if (!res.ok) return null;
	return res.json().catch(() => null);
}

// ---------------------------------------------------------------------------
// Reading a car
// ---------------------------------------------------------------------------

/** The cars this person connected: id plus what Smartcar already knows about each. */
async function listCars(profileId, { userId, fetchImpl } = {}) {
	const who = userId || (await userIdOf(profileId));
	const out = new Map();
	for (let page = 1; page <= 5; page += 1) {
		const q = new URLSearchParams({ "filter[userId]": who, "page[number]": String(page), "page[size]": "50" });
		const data = await v3(profileId, `/connections?${q}`, { userId: who, fetchImpl });
		const rows = Array.isArray(data?.data) ? data.data : [];
		for (const c of rows) {
			const id = c?.relationships?.vehicle?.data?.id;
			if (isId(id) && !out.has(id)) out.set(id, c.attributes?.vehicle || {});
		}
		if (rows.length < 50) break;
	}
	return out;
}

const SIGNALS = {
	odometer: "odometer-traveleddistance",
	fuel: "internalcombustionengine-fuellevel",
	fuelRange: "internalcombustionengine-range",
	charge: "tractionbattery-stateofcharge",
	chargeRange: "tractionbattery-range",
	locked: "closure-islocked",
	location: "location-preciselocation",
	vin: "vehicleidentification-vin",
};

/** The body of one signal, or null when the car can't report it. */
function bodyOf(data) {
	const attrs = data?.data?.attributes || data?.attributes || null;
	if (!attrs) return null;
	if (attrs.status?.value && attrs.status.value !== "SUCCESS") return null;
	return attrs.body ?? null;
}

/** A distance body in miles, whichever unit the car reports in. */
function miles(body) {
	const v = Number(body?.value);
	if (!Number.isFinite(v)) return null;
	return /^mi/i.test(String(body?.unit || "km")) ? Math.round(v) : Math.round(v / KM_PER_MI);
}
const percent = (body) => (Number.isFinite(Number(body?.value)) ? Math.round(Number(body.value)) : null);

/** Everything worth keeping about one car, live. Location only when asked for. */
async function readCar(profileId, id, { location = false, userId, fetchImpl, info = {} } = {}) {
	const who = userId || (await userIdOf(profileId));
	const codes = Object.entries(SIGNALS).filter(([k]) => location || k !== "location");
	const got = {};
	await Promise.all(codes.map(async ([key, code]) => {
		got[key] = bodyOf(await v3(profileId, `/vehicles/${encodeURIComponent(id)}/signals/${code}`, { userId: who, fetchImpl }).catch((err) => {
			if (err?.code === "not_connected") throw err;
			return null;
		}));
	}));
	const loc = got.location;
	const fuel = percent(got.fuel);
	const charge = percent(got.charge);
	return {
		make: info.make || null,
		model: info.model || null,
		year: Number.isInteger(info.year) ? info.year : null,
		vin: typeof got.vin?.value === "string" ? got.vin.value.toUpperCase().slice(0, 17) : null,
		odometerMi: miles(got.odometer),
		fuel: fuel !== null ? { percent: fuel, rangeMi: miles(got.fuelRange) } : null,
		battery: charge !== null ? { percent: charge, rangeMi: miles(got.chargeRange) } : null,
		locked: typeof got.locked?.value === "boolean" ? got.locked.value : typeof got.locked?.isLocked === "boolean" ? got.locked.isLocked : null,
		location: loc && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)
			? { latitude: Math.round(loc.latitude * 1e6) / 1e6, longitude: Math.round(loc.longitude * 1e6) / 1e6 }
			: null,
	};
}

function parse(v) {
	if (!v) return null;
	if (typeof v === "object") return v;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
}

/**
 * Read every granted car and store it. A car no longer granted is dropped.
 * Auto-links by VIN to the person's own vehicle, and carries the odometer
 * over to a linked vehicle when it is higher than what's on file.
 */
async function sync(profileId, { now = new Date() } = {}) {
	const userId = await userIdOf(profileId);
	const cars = await listCars(profileId, { userId });
	const ids = [...cars.keys()];
	const [rows] = await pool.query("SELECT smartcar_id, vehicle_id, location_enabled FROM athena_smartcar_vehicle WHERE profile_id = ?", [profileId]);
	const byId = new Map(rows.map((r) => [r.smartcar_id, r]));
	const [mine] = await pool.query("SELECT id, vin, odometer FROM athena_property_vehicle WHERE profile_id = ?", [profileId]);
	for (const id of ids) {
		const prev = byId.get(id);
		const locationOn = !!Number(prev?.location_enabled);
		const car = await readCar(profileId, id, { location: locationOn, userId, info: cars.get(id) });
		let vehicleId = prev?.vehicle_id || null;
		if (!vehicleId && car.vin) vehicleId = mine.find((v) => v.vin && v.vin === car.vin)?.id || null;
		await pool.query(
			`INSERT INTO athena_smartcar_vehicle
				(profile_id, smartcar_id, vehicle_id, make, model, year, vin, odometer_mi, fuel, battery, locked,
				 latitude, longitude, location_at, synced_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE vehicle_id = VALUES(vehicle_id), make = VALUES(make), model = VALUES(model),
				year = VALUES(year), vin = VALUES(vin), odometer_mi = COALESCE(VALUES(odometer_mi), odometer_mi),
				fuel = VALUES(fuel), battery = VALUES(battery), locked = VALUES(locked),
				latitude = IF(location_enabled, COALESCE(VALUES(latitude), latitude), NULL),
				longitude = IF(location_enabled, COALESCE(VALUES(longitude), longitude), NULL),
				location_at = IF(location_enabled, COALESCE(VALUES(location_at), location_at), NULL),
				synced_at = VALUES(synced_at)`,
			[profileId, id, vehicleId, car.make, car.model, car.year, car.vin, car.odometerMi,
				car.fuel ? JSON.stringify(car.fuel) : null, car.battery ? JSON.stringify(car.battery) : null,
				car.locked === null ? null : car.locked ? 1 : 0,
				locationOn ? car.location?.latitude ?? null : null, locationOn ? car.location?.longitude ?? null : null,
				locationOn && car.location ? now : null, now]
		);
		const linked = vehicleId && mine.find((v) => Number(v.id) === Number(vehicleId));
		if (linked && car.odometerMi !== null && (linked.odometer === null || car.odometerMi > linked.odometer)) {
			await pool.query(
				"UPDATE athena_property_vehicle SET odometer = ?, odometer_on = ? WHERE id = ? AND profile_id = ?",
				[car.odometerMi, now.toISOString().slice(0, 10), linked.id, profileId]
			);
		}
	}
	await pool.query(
		ids.length
			? "DELETE FROM athena_smartcar_vehicle WHERE profile_id = ? AND smartcar_id NOT IN (?)"
			: "DELETE FROM athena_smartcar_vehicle WHERE profile_id = ?",
		ids.length ? [profileId, ids] : [profileId]
	);
	return ids.length;
}

async function refreshIfStale(profileId, { now = new Date(), maxAgeMs = STALE_MS } = {}) {
	const [rows] = await pool.query(
		"SELECT MIN(synced_at) AS oldest, COUNT(*) AS n FROM athena_smartcar_vehicle WHERE profile_id = ?",
		[profileId]
	);
	const oldest = rows[0]?.oldest ? new Date(rows[0].oldest).getTime() : 0;
	if (rows[0]?.n && now.getTime() - oldest < maxAgeMs) return false;
	await sync(profileId, { now });
	return true;
}

function shape(r) {
	return {
		id: r.smartcar_id,
		vehicleUuid: r.vehicle_uuid || null,
		vehicleName: r.vehicle_name || null,
		make: r.make,
		model: r.model,
		year: r.year,
		vin: r.vin,
		odometerMi: r.odometer_mi,
		fuel: parse(r.fuel),
		battery: parse(r.battery),
		locked: r.locked === null || r.locked === undefined ? null : !!Number(r.locked),
		locationEnabled: !!Number(r.location_enabled),
		location: r.latitude !== null && r.latitude !== undefined ? { latitude: Number(r.latitude), longitude: Number(r.longitude), at: r.location_at ? new Date(r.location_at).toISOString() : null } : null,
		syncedAt: r.synced_at ? new Date(r.synced_at).toISOString() : null,
	};
}

async function stored(profileId) {
	const [rows] = await pool.query(
		`SELECT s.*, v.uuid AS vehicle_uuid, v.name AS vehicle_name FROM athena_smartcar_vehicle s
		 LEFT JOIN athena_property_vehicle v ON v.id = s.vehicle_id AND v.profile_id = s.profile_id
		 WHERE s.profile_id = ? ORDER BY s.created_at, s.id`,
		[profileId]
	);
	return rows.map(shape);
}

/**
 * The person ties a car to one of their vehicles (or none), and turns its
 * location on or off. Off clears any location already kept.
 */
async function setLink(profileId, smartcarId, { vehicleUuid, locationEnabled } = {}) {
	const bad = (m, status = 400) => Object.assign(new Error(m), { status });
	if (!isId(smartcarId)) throw bad("Unknown car.");
	const [own] = await pool.query("SELECT id FROM athena_smartcar_vehicle WHERE profile_id = ? AND smartcar_id = ?", [profileId, smartcarId]);
	if (!own.length) throw bad("That car is no longer linked.", 404);
	if (vehicleUuid !== undefined) {
		let vehicleId = null;
		if (vehicleUuid !== null) {
			const [v] = await pool.query("SELECT id FROM athena_property_vehicle WHERE profile_id = ? AND uuid = ?", [profileId, String(vehicleUuid)]);
			if (!v.length) throw bad("That vehicle is no longer on your list.", 404);
			vehicleId = v[0].id;
		}
		await pool.query("UPDATE athena_smartcar_vehicle SET vehicle_id = ? WHERE id = ?", [vehicleId, own[0].id]);
	}
	if (locationEnabled !== undefined) {
		if (typeof locationEnabled !== "boolean") throw bad("Location is on or off.");
		await pool.query(
			locationEnabled
				? "UPDATE athena_smartcar_vehicle SET location_enabled = 1 WHERE id = ?"
				: "UPDATE athena_smartcar_vehicle SET location_enabled = 0, latitude = NULL, longitude = NULL, location_at = NULL WHERE id = ?",
			[own[0].id]
		);
	}
	return stored(profileId);
}

/** Nightly: every person with a live link, re-read if stale. One failure never stops the rest. */
async function syncEveryone() {
	const [rows] = await pool.query("SELECT DISTINCT profile_id FROM user_credential WHERE provider = 'smartcar' AND status = 'active'");
	let synced = 0, failed = 0;
	for (const { profile_id: profileId } of rows) {
		try {
			if (await refreshIfStale(Number(profileId))) synced += 1;
		} catch (err) {
			failed += 1;
			console.warn("[smartcar] nightly sync failed:", profileId, err.message);
		}
	}
	return { synced, failed };
}

function carTitle(c) {
	return c.vehicleName || [c.year, c.make, c.model].filter(Boolean).join(" ") || "Car";
}

function formatCar(c) {
	const bits = [];
	if (c.odometerMi !== null) bits.push(`${c.odometerMi.toLocaleString("en-US")} mi on the odometer`);
	if (c.fuel?.percent !== null && c.fuel?.percent !== undefined) bits.push(`fuel ${c.fuel.percent}%${c.fuel.rangeMi ? ` (about ${c.fuel.rangeMi} mi of range)` : ""}`);
	if (c.battery?.percent !== null && c.battery?.percent !== undefined) bits.push(`battery ${c.battery.percent}%${c.battery.rangeMi ? ` (about ${c.battery.rangeMi} mi)` : ""}`);
	if (c.locked !== null) bits.push(c.locked ? "locked" : "UNLOCKED");
	if (c.location) bits.push(`parked at ${c.location.latitude}, ${c.location.longitude}${c.location.at ? ` as of ${c.location.at}` : ""}`);
	else if (!c.locationEnabled) bits.push("location not shared (they can turn it on per car on Property → Vehicles)");
	return `- ${carTitle(c)} — ${bits.join(", ") || "no readings"}${c.syncedAt ? ` (read ${c.syncedAt})` : ""}`;
}

/** Grounding block. Falls back to the stored readings when the car can't be reached, saying so. */
async function buildContext(profileId) {
	let note = "";
	try {
		await refreshIfStale(profileId);
	} catch (err) {
		if (err?.code === "not_connected") throw err;
		note = " (Smartcar could not be reached just now; these are the last readings I have)";
	}
	const cars = await stored(profileId);
	if (!cars.length) return `Smartcar: linked, but no cars are shared with Athena${note}.`;
	return [`Cars read through Smartcar${note} — read-only; Athena cannot lock, unlock or start them:`, ...cars.map(formatCar)].join("\n");
}

const FUNCTION_DECLARATIONS = [
	{
		name: "get_car_status",
		description:
			"The person's cars read through Smartcar: odometer, fuel or battery level and range, whether each is locked, " +
			"and where it is parked if they turned location on for that car. " +
			'Use for "how many miles are on the BMW", "do I need gas", "did I lock the car" or "where did I park". Read-only.',
		parameters: { type: "OBJECT", properties: {} },
	},
];

async function executeTool(name, _args = {}, { profileId }) {
	if (name !== "get_car_status") throw new Error(`Unknown Smartcar tool: ${name}`);
	let stale = false;
	try {
		await refreshIfStale(profileId, { maxAgeMs: 15 * 60_000 });
	} catch (err) {
		if (err?.code === "not_connected") throw err;
		stale = true;
	}
	return { cars: await stored(profileId), ...(stale ? { note: "Smartcar could not be reached; last readings." } : {}) };
}

module.exports = {
	PROVIDER,
	LABEL,
	matches,
	appToken,
	listCars,
	readCar,
	SIGNALS,
	_resetToken: () => (cachedToken = null),
	sync,
	refreshIfStale,
	stored,
	setLink,
	syncEveryone,
	formatCar,
	buildContext,
	FUNCTION_DECLARATIONS,
	executeTool,
};
