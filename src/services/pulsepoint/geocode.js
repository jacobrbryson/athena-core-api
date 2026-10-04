/**
 * An address a person typed -> a point to watch.
 *
 * Uses the US Census Bureau geocoder: free, no key, no account, and built for
 * exactly this — US street addresses. The watched places are family homes in
 * the US, and a paid geocoder with a key to rotate would be a second secret
 * for a lookup that happens a handful of times a year.
 *
 * The honest limits: US addresses only, and it matches street addresses, not
 * business names ("Mom's church" will not resolve; its address will). The
 * places panel also offers "use my current location" for everything else.
 *
 * The person's own request, one lookup per keystroke-pause, sent from the
 * server so the browser never talks to a third party with their session.
 */
const https = require("node:https");

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 512 * 1024;
const MAX_RESULTS = 5;

const bad = (message) => Object.assign(new Error(message), { status: 400 });

function get(url) {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { timeout: TIMEOUT_MS, headers: { Accept: "application/json" } }, (response) => {
			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error(`The address lookup answered ${response.statusCode}.`));
				return;
			}
			let size = 0;
			const chunks = [];
			response.on("data", (chunk) => {
				size += chunk.length;
				if (size > MAX_BYTES) {
					request.destroy();
					reject(new Error("The address lookup sent too much."));
					return;
				}
				chunks.push(chunk);
			});
			response.on("end", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch {
					reject(new Error("The address lookup sent something unreadable."));
				}
			});
		});
		request.on("timeout", () => {
			request.destroy();
			reject(new Error("The address lookup did not answer in time."));
		});
		request.on("error", reject);
	});
}

/** Candidate points for an address, best first. Empty when nothing matched. */
async function lookup(query) {
	const q = typeof query === "string" ? query.trim() : "";
	if (q.length < 5) throw bad("Type a street address, with the town or ZIP.");
	if (q.length > 200) throw bad("That address is too long.");
	const url =
		"https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
		`?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&format=json`;
	const data = await get(url);
	const matches = Array.isArray(data?.result?.addressMatches) ? data.result.addressMatches : [];
	return matches.slice(0, MAX_RESULTS).map((m) => ({
		label: String(m.matchedAddress || q),
		// Census returns x = longitude, y = latitude.
		latitude: Math.round(Number(m.coordinates?.y) * 1e6) / 1e6,
		longitude: Math.round(Number(m.coordinates?.x) * 1e6) / 1e6,
	})).filter((m) => Number.isFinite(m.latitude) && Number.isFinite(m.longitude));
}

/**
 * A point -> the towns to try when an address arrives without one: its ZIP
 * ("28677") first, then its town and state ("Statesville, NC"). Dispatch text
 * rarely names the town, and the town of a saved place is the wrong guess when
 * the person is somewhere else — the Census geocoder finds nothing for a
 * Statesville street asked about as if it were in Troutman.
 *
 * Empty when the lookup fails; callers fall back to their saved places.
 */
async function regionsAt(point) {
	const latitude = Number(point?.latitude);
	const longitude = Number(point?.longitude);
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
	const layers = ["2020 Census ZIP Code Tabulation Areas", "Incorporated Places", "County Subdivisions", "States"];
	const url =
		"https://geocoding.geo.census.gov/geocoder/geographies/coordinates" +
		`?x=${longitude}&y=${latitude}&benchmark=Public_AR_Current&vintage=Current_Current` +
		`&layers=${encodeURIComponent(layers.join(","))}&format=json`;
	const found = (await get(url))?.result?.geographies || {};
	const first = (layer, field) => {
		const value = Array.isArray(found[layer]) ? found[layer][0]?.[field] : null;
		return typeof value === "string" && value.trim() ? value.trim() : null;
	};
	const zip = first(layers[0], "ZCTA5");
	const town = first(layers[1], "BASENAME") || first(layers[2], "BASENAME");
	const state = first(layers[3], "STUSAB");
	const out = [];
	if (zip) out.push(zip);
	if (town && state) out.push(`${town}, ${state}`);
	return out;
}

module.exports = { lookup, regionsAt };
