/**
 * National Weather Service alerts for a watched place.
 *
 * The other half of "what is happening near me", and the half that still
 * works: api.weather.gov is an official US government API, free, no key, and
 * published for exactly this use. It answers "what warnings cover this exact
 * point", which is the shape the watched places already have.
 *
 * ## What counts as urgent
 *
 * NWS grades every alert itself, and that grading is better than anything we
 * would invent:
 *
 *   severity  Extreme | Severe | Moderate | Minor | Unknown
 *   urgency   Immediate | Expected | Future | Past | Unknown
 *
 * A tornado warning is Extreme/Immediate; a tornado WATCH is Severe/Future.
 * Both matter, but only one of them should wake somebody at 2am — so urgent
 * needs a serious severity AND a clock that has already started. Advisories
 * (Minor) are weather, not an emergency, and are dropped entirely rather than
 * turned into another thing to look at.
 *
 * Test and exercise messages, cancellations and expired alerts never appear:
 * `status: Actual`, a message type that is not Cancel, and an expiry in the
 * future are all required.
 */
const https = require("node:https");

const HOST = "api.weather.gov";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
/** NWS asks for a contact address in the User-Agent, and is right to. */
const USER_AGENT =
	process.env.NWS_USER_AGENT || "AthenaNearbyIncidents/1.0 (household emergency alerts; contact via app owner)";

const SERIOUS = new Set(["Extreme", "Severe"]);
const UNDER_WAY = new Set(["Immediate", "Expected"]);
const WORTH_TELLING = new Set(["Extreme", "Severe", "Moderate"]);

function get(path) {
	return new Promise((resolve, reject) => {
		const request = https.get(
			{ host: HOST, path, headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" }, timeout: TIMEOUT_MS },
			(response) => {
				if (response.statusCode !== 200) {
					response.resume();
					reject(new Error(`The weather service answered ${response.statusCode}.`));
					return;
				}
				let size = 0;
				const chunks = [];
				response.on("data", (chunk) => {
					size += chunk.length;
					if (size > MAX_BYTES) {
						request.destroy();
						reject(new Error("The weather service sent more than we agreed to read."));
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch {
						reject(new Error("The weather service sent something unreadable."));
					}
				});
			}
		);
		request.on("timeout", () => {
			request.destroy();
			reject(new Error("The weather service did not answer in time."));
		});
		request.on("error", reject);
	});
}

/** Their alert -> ours, or null when it is not worth anyone's attention. */
function alert(feature, place) {
	const p = feature?.properties;
	if (!p || p.status !== "Actual" || p.messageType === "Cancel") return null;
	if (!WORTH_TELLING.has(p.severity)) return null;
	if (p.urgency === "Past") return null;
	const expires = p.expires ? new Date(p.expires) : null;
	if (expires && expires.getTime() < Date.now()) return null;
	return {
		id: String(p.id),
		event: p.event || "Weather alert",
		severity: p.severity,
		urgency: p.urgency,
		// NWS headlines carry the issuing times; the event and the area read
		// better in one line and the full headline is there if wanted.
		headline: (p.headline || p.event || "").slice(0, 300),
		instruction: (p.instruction || "").trim().slice(0, 300) || null,
		area: (p.areaDesc || "").slice(0, 200),
		onset: p.onset || p.effective || null,
		expires: p.expires || null,
		place: place.live ? "you" : place.name,
		serious: SERIOUS.has(p.severity) && UNDER_WAY.has(p.urgency),
	};
}

/**
 * Active alerts over one point. Never throws for "nothing there" — an empty
 * list is the normal answer on most days.
 */
async function alertsForPlace(place) {
	const lat = Number(place.latitude).toFixed(4);
	const lon = Number(place.longitude).toFixed(4);
	const data = await get(`/alerts/active?point=${lat},${lon}`);
	const features = Array.isArray(data?.features) ? data.features : [];
	return features.map((f) => alert(f, place)).filter(Boolean);
}

/**
 * Alerts over every watched place, deduped by alert id — one storm covering
 * home and a parent's house is one alert, remembered against the nearest
 * place it was found for.
 */
async function alertsForPlaces(places = []) {
	const byId = new Map();
	for (const place of places) {
		for (const found of await alertsForPlace(place)) {
			if (!byId.has(found.id)) byId.set(found.id, found);
		}
	}
	return [...byId.values()].sort((a, b) => Number(b.serious) - Number(a.serious));
}

module.exports = { alertsForPlace, alertsForPlaces, alert };
