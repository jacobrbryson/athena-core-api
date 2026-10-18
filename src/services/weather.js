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
	const dailyUrl = point?.properties?.forecast;
	const value = { place: where ? `${where.city}, ${where.state}` : null, periods, dailyUrl: dailyUrl && dailyUrl.startsWith(HOST) ? dailyUrl : null };
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

/**
 * Local wall-clock for an NWS time. NWS writes every period in the point's own
 * offset ("2026-10-19T06:00:00-04:00"), so the local date and hour are in the
 * string itself and no time-zone table is needed.
 */
function local(iso) {
	const offset = /([+-])(\d{2}):(\d{2})$/.exec(String(iso || ""));
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return null;
	const shift = offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000 : 0;
	const wall = new Date(ms + shift);
	return {
		ms,
		date: wall.toISOString().slice(0, 10),
		hour: wall.getUTCHours(),
		// The evening a night belongs to: 5 AM Tuesday is Monday night.
		night: new Date(ms + shift - 12 * 3_600_000).toISOString().slice(0, 10),
	};
}

/** "5 to 15 mph" -> 15; the gust when NWS gives one and it is higher. */
function windMph(period) {
	const speeds = [period?.windSpeed, period?.windGust]
		.flatMap((value) => String(value?.value ?? value ?? "").match(/\d+/g) || [])
		.map(Number);
	return speeds.length ? Math.max(...speeds) : null;
}

const cToF = (c) => (Number.isFinite(c) ? Math.round((c * 9) / 5 + 32) : null);

/** One hourly NWS period, with what the outlook and the alert rules read. */
function hourOf(p) {
	return {
		start: p.startTime,
		temperatureF: p.temperatureUnit === "F" ? p.temperature : null,
		precipitationChance: p.probabilityOfPrecipitation?.value ?? null,
		dewpointF: p.dewpoint?.unitCode?.endsWith("degC") ? cToF(p.dewpoint.value) : (p.dewpoint?.value ?? null),
		humidity: p.relativeHumidity?.value ?? null,
		windSpeed: p.windSpeed || null,
		windMph: windMph(p),
		windDirection: p.windDirection || null,
		shortForecast: p.shortForecast || null,
		isDaytime: typeof p.isDaytime === "boolean" ? p.isDaytime : null,
	};
}

/**
 * How likely frost is on one night, from the coldest forecast hour.
 *
 * The forecast is air temperature about two metres up; grass and windshields
 * on a still, clear night run several degrees colder, which is why frost
 * forms with the forecast at 34-36°F. Wind stirs warmer air back down and
 * cloud holds the day's heat in, so either one makes the same low less frosty.
 */
function frostRisk(lowF, { windMph: wind = null, shortForecast = "" } = {}) {
	if (!Number.isFinite(lowF)) return "unknown";
	if (lowF <= 28) return "hard_freeze";
	if (lowF <= 32) return "freeze";
	const still = wind !== null && wind <= 5;
	const clear = /clear|sunny|fair/i.test(shortForecast || "") && !/cloud/i.test(shortForecast || "");
	if (lowF <= 36) return still || clear ? "likely" : "possible";
	if (lowF <= 38 && still && clear) return "possible";
	return "none";
}

/** The coldest hour of each night (6 PM - 9 AM local) in the hourly forecast. */
function nightsOf(hours) {
	const nights = new Map();
	for (const hour of hours) {
		const at = local(hour.start);
		if (!at || !Number.isFinite(hour.temperatureF) || (at.hour > 9 && at.hour < 18)) continue;
		const night = nights.get(at.night);
		if (!night || hour.temperatureF < night.lowF) nights.set(at.night, { night: at.night, lowF: hour.temperatureF, at: hour.start, hour });
	}
	return [...nights.values()].map(({ hour, ...night }) => ({
		...night,
		windMph: hour.windMph,
		shortForecast: hour.shortForecast,
		risk: frostRisk(night.lowF, hour),
	}));
}

async function dailyFor(url) {
	const hit = cache.get(url);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
	const daily = await getJson(url);
	const value = daily?.properties?.periods || [];
	cache.set(url, { at: Date.now(), value });
	if (cache.size > 64) cache.delete(cache.keys().next().value);
	return value;
}

/**
 * The longer read the Weather panel shows: the next 48 hours with humidity,
 * dew point and wind, seven days of highs and lows, and a frost read for
 * every night NWS forecasts hourly (about six). Null, never a guess, when NWS
 * can't answer; a daily forecast that fails leaves `days` empty and keeps the
 * rest.
 */
async function outlook(latitude, longitude) {
	if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return null;
	try {
		const raw = await hourlyFor(latitude, longitude);
		if (!raw) return null;
		const now = Date.now();
		const hours = raw.periods
			.filter((p) => new Date(p.endTime || p.startTime).getTime() > now)
			.map(hourOf);
		if (!hours.length) return null;
		let days = [];
		if (raw.dailyUrl) {
			const periods = await dailyFor(raw.dailyUrl).catch(() => []);
			const byDate = new Map();
			for (const p of periods) {
				const at = local(p.startTime);
				if (!at) continue;
				// A night period belongs to the day it starts on ("Tonight" -> today).
				const day = byDate.get(at.date) || { date: at.date, name: null, highF: null, lowF: null, shortForecast: null, detailedForecast: null, precipitationChance: null };
				const temp = p.temperatureUnit === "F" ? p.temperature : null;
				if (p.isDaytime) Object.assign(day, { name: p.name, highF: temp, shortForecast: p.shortForecast, detailedForecast: p.detailedForecast });
				else Object.assign(day, { lowF: temp, name: day.name || p.name, shortForecast: day.shortForecast || p.shortForecast, detailedForecast: day.detailedForecast || p.detailedForecast });
				const chance = p.probabilityOfPrecipitation?.value;
				if (Number.isFinite(chance)) day.precipitationChance = Math.max(day.precipitationChance ?? 0, chance);
				byDate.set(at.date, day);
			}
			days = [...byDate.values()].slice(0, 7);
		}
		const nights = nightsOf(hours);
		return {
			place: raw.place,
			now: hours[0],
			hours: hours.slice(0, 48),
			days,
			nights,
			// The first night with any frost in it: the line the panel leads with.
			nextFrost: nights.find((n) => n.risk !== "none" && n.risk !== "unknown") || null,
			checkedAt: new Date().toISOString(),
		};
	} catch (err) {
		console.warn("[weather] outlook unavailable:", err.message);
		return null;
	}
}

/** Every hourly period NWS has for a point (about six days), as `hourOf` rows. Null when it can't answer. */
async function hourlyRows(latitude, longitude) {
	if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return null;
	const raw = await hourlyFor(latitude, longitude);
	return raw ? { place: raw.place, hours: raw.periods.map(hourOf) } : null;
}

module.exports = { forecast, outlook, hourlyRows, frostRisk, nightsOf, local, windMph };
