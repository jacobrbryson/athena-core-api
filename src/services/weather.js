/**
 * The next few hours of weather, for one point on the map.
 *
 * This exists for one sentence on the dashboard: a trail system whose hours
 * are "weather dependent" is not actually answerable without it, and a
 * suggestion to go outside that ignores the rain is the kind of wrong that
 * makes someone stop reading suggestions.
 *
 * The US National Weather Service is used because it needs no key, no account
 * and no per-person consent — the only thing sent is a coordinate the person
 * typed for a public place, never their own location. Outside its coverage it
 * returns nothing, and every caller is built to carry on without it: no
 * weather is "I don't know", never "it's fine".
 */
const HOST = "https://api.weather.gov";
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 30 * 60_000;
const USER_AGENT = process.env.WEATHER_USER_AGENT || "Athena/1.0 (personal assistant; one point per place)";

const cache = new Map(); // "lat,lon" => { at, value }

async function getJson(url) {
	const response = await fetch(url, {
		headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`weather.gov answered ${response.status}`);
	return response.json();
}

/** Four decimals is ~11m, which is all NWS resolves anyway, and it makes the cache hit. */
const round = (value) => Number(Number(value).toFixed(4));

/**
 * The raw hourly periods for a point (about a week of them), cached. Null
 * when the point is outside NWS coverage or the service is unreachable.
 */
async function hourlyFor(latitude, longitude) {
	const key = `${round(latitude)},${round(longitude)}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
	const point = await getJson(`${HOST}/points/${key}`);
	const hourlyUrl = point?.properties?.forecastHourly;
	if (!hourlyUrl || !hourlyUrl.startsWith(HOST)) return null;
	const hourly = await getJson(hourlyUrl);
	const periods = hourly?.properties?.periods || [];
	if (!periods.length) return null;
	const where = point?.properties?.relativeLocation?.properties;
	const value = { place: where ? `${where.city}, ${where.state}` : null, periods };
	cache.set(key, { at: Date.now(), value });
	if (cache.size > 64) cache.delete(cache.keys().next().value);
	return value;
}

/**
 * Hour-by-hour for `hours` starting now — or starting at `from` (an ISO time,
 * up to about a week out: "the 5:30 game tomorrow") — plus a one-line read on
 * whether outdoor plans survive it. Returns null — never a guess — when the
 * point is outside NWS coverage, the service is unreachable, or `from` is
 * beyond what NWS forecasts.
 */
async function forecast(latitude, longitude, { hours = 8, from = null } = {}) {
	if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return null;
	try {
		const raw = await hourlyFor(latitude, longitude);
		if (!raw) return null;
		const startAt = from ? new Date(from).getTime() : NaN;
		// The period that contains `from`, or the first one when there is no `from`.
		const first = Number.isFinite(startAt)
			? raw.periods.findIndex((p) => new Date(p.endTime || p.startTime).getTime() > startAt)
			: 0;
		if (first < 0) return null;
		const periods = raw.periods.slice(first, first + Math.max(1, Math.min(hours, 24)));
		if (!periods.length) return null;

		const window = periods.map((p) => ({
			start: p.startTime,
			temperatureF: p.temperatureUnit === "F" ? p.temperature : null,
			precipitationChance: p.probabilityOfPrecipitation?.value ?? null,
			windSpeed: p.windSpeed || null,
			shortForecast: p.shortForecast || null,
			isDaytime: typeof p.isDaytime === "boolean" ? p.isDaytime : null,
		}));
		const wettest = Math.max(...window.map((h) => h.precipitationChance ?? 0));
		const raining = /rain|shower|storm|thunder|sleet|snow|ice/i;
		return {
			place: raw.place,
			now: window[0],
			hours: window,
			maxPrecipitationChance: Number.isFinite(wettest) ? wettest : null,
			// The judgment the dashboard actually needs, made once and named.
			// 50% is not a forecast of rain, but it is enough that "the trails
			// may be wet" belongs in the sentence.
			outdoorOutlook: window.some((h) => raining.test(h.shortForecast || "")) || wettest >= 50 ? "wet" : "fine",
			checkedAt: new Date().toISOString(),
		};
	} catch (err) {
		console.warn("[weather] unavailable:", err.message);
		return null;
	}
}

module.exports = { forecast };
