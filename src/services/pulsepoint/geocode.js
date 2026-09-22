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

module.exports = { lookup };
