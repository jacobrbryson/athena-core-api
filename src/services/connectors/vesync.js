const crypto = require("crypto");
const credentials = require("../credentials");
const bodyComposition = require("../bodyComposition");

/**
 * VeSync (Etekcity) smart scale — weight and body composition, read-only.
 *
 * VeSync has no public API and no OAuth, so this speaks the VeSync app's own
 * API, the one Home Assistant's pyvesync and ioBroker.vesync use. It can break
 * whenever VeSync changes it; when it does, the error is VeSync's own words,
 * not a guess.
 *
 * The link is a `vesync` api_key credential the owner adds with
 * scripts/addVesyncLogin.js. Its columns are used like this:
 *
 *   access_token_enc    the VeSync session token
 *   refresh_token_enc   the VeSync password — the only way VeSync renews a
 *                       session is logging in again
 *   external_account_id VeSync's accountID
 *   display_name        the VeSync email
 *   token_type          the API region, "US" or "EU"
 *
 * Health data, so every read requires the family's health_data consent, the
 * same gate Whoop's link passes through.
 */

const PROVIDER = "vesync";
const LABEL = "VeSync scale";
// There is no Connect button: the owner links it with a script.
const HOW_TO_LINK = "that the owner can link a VeSync scale for them — there is no Connect button for it in the app";
const HOW_TO_RELINK = "VeSync refused the saved login (usually a changed VeSync password), and the owner re-adding it is the fix";
const TIMEOUT_MS = 12000;
const CACHE_MS = 30 * 60_000;
const APP_VERSION = "5.7.80";
const APP_ID = "eldodkfj";
const HOSTS = { US: "https://smartapi.vesync.com", EU: "https://smartapi.vesync.eu" };

const KEYWORDS =
	/\b(weigh|weighs|weighed|weight|weigh-ins?|my scale|smart scale|vesync|etekcity|body fat|bmi|body composition|muscle mass|lean mass|visceral fat|bone mass|body water|bmr|metabolic age)\b/i;

function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

function fail(message, code = "provider_error", extra = {}) {
	return Object.assign(new Error(message), { code, ...extra });
}

/** Stable per profile, so VeSync sees one device, not a new phone each login. */
function terminalIdFor(profileId) {
	return crypto.createHash("sha256").update(`athena-vesync:${profileId}`).digest("hex").slice(0, 32).toUpperCase();
}

function hostFor(region) {
	return HOSTS[region === "EU" ? "EU" : "US"];
}

async function post(url, body) {
	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "okhttp/3.12.1" },
			body: JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw fail(`VeSync request failed: ${err.message}`);
	}
	if (!response.ok) throw fail(`VeSync: HTTP ${response.status}`, "provider_error", { providerStatus: response.status });
	const data = await response.json().catch(() => null);
	if (!data) throw fail("VeSync sent a response that was not JSON");
	return data;
}

function baseContext(method, { profileId, accountID = "", token = "", region = "US" }) {
	return {
		acceptLanguage: "en",
		accountID,
		appVersion: APP_VERSION,
		appID: APP_ID,
		sourceAppID: APP_ID,
		clientInfo: "Athena",
		clientType: "vesyncApp",
		clientVersion: `VeSync ${APP_VERSION}`,
		debugMode: false,
		method,
		osInfo: "Android",
		phoneBrand: "Athena",
		phoneOS: "Android",
		terminalId: terminalIdFor(profileId),
		timeZone: "America/New_York",
		token,
		traceId: String(Date.now()),
		userCountryCode: region,
	};
}

/**
 * Email + password -> { token, accountID, region }.
 *
 * VeSync's two-step login: the password buys an authorize code, which buys a
 * session token. An account homed in the other region answers the second
 * step with a bizToken, and the exchange is repeated against that region.
 */
async function login({ profileId, email, password, region = "US" }) {
	const md5 = crypto.createHash("md5").update(password).digest("hex");
	const auth = await post(`${hostFor(region)}/globalPlatform/api/accountAuth/v1/authByPWDOrOTM`, {
		...baseContext("authByPWDOrOTM", { profileId, region }),
		email,
		password: md5,
		authProtocolType: "generic",
	});
	if (auth.code !== 0 || !auth.result?.authorizeCode) {
		throw fail(`VeSync refused the login: ${auth.msg || "no reason given"} (code ${auth.code})`, "login_rejected");
	}
	const { authorizeCode, accountID } = auth.result;
	const exchange = (host, extra) =>
		post(`${host}/user/api/accountManage/v1/loginByAuthorizeCode4Vesync`, {
			...baseContext("loginByAuthorizeCode4Vesync", { profileId, region }),
			accountID,
			authorizeCode,
			...extra,
		});
	let session = await exchange(hostFor(region), { userCountryCode: region });
	if (session.code !== 0 && session.result?.bizToken) {
		const home = session.result.currentRegion === "EU" ? "EU" : "US";
		session = await exchange(hostFor(home), {
			bizToken: session.result.bizToken,
			regionChange: "lastRegion",
			userCountryCode: session.result.countryCode || home,
		});
	}
	if (session.code !== 0 || !session.result?.token) {
		throw fail(`VeSync refused the login: ${session.msg || "no reason given"} (code ${session.code})`, "login_rejected");
	}
	return {
		token: session.result.token,
		accountID: String(session.result.accountID || accountID),
		region: session.result.currentRegion === "EU" ? "EU" : "US",
	};
}

/** The scale's configModule, which the weigh-in read is keyed by. */
async function findScale(session, profileId) {
	const data = await post(`${hostFor(session.region)}/cloud/v2/deviceManaged/devices`, {
		...baseContext("devices", { profileId, ...session }),
		pageNo: 1,
		pageSize: 100,
	});
	if (data.code !== 0) throw fail(`VeSync device list: ${data.msg || "error"} (code ${data.code})`, "session_rejected");
	// Etekcity scales are the ES* device types (ESF-551, ESF00+, ...).
	const scale = (data.result?.list || []).find((d) => String(d.deviceType || "").startsWith("ES"));
	if (!scale) throw fail("No VeSync scale is registered to this VeSync account");
	return { configModule: scale.configModule, name: scale.deviceName || scale.deviceType };
}

const PAGE_SIZE = 100;
// 3,000 weigh-ins: years of daily use, and a ceiling on one read.
const MAX_PAGES = 30;

async function fetchPage(session, profileId, configModule, page) {
	const data = await post(`${hostFor(session.region)}/iot/api/fitnessScale/getWeighingDataV4`, {
		context: baseContext("getWeighingDataV4", { profileId, ...session }),
		data: {
			allData: true,
			configModule,
			page,
			pageSize: PAGE_SIZE,
			// null is the account holder; family members the scale knows about
			// are sub-users and are not read.
			subUserID: null,
			uploadTimestamp: null,
			weightUnit: "kg",
		},
	});
	if (data.code !== 0) throw fail(`VeSync weigh-ins: ${data.msg || "error"} (code ${data.code})`, "session_rejected");
	const result = data.result || {};
	return result.weightDatas || result.weighingDataList || result.list || result.records || [];
}

/**
 * Every weigh-in on the account. VeSync pages them OLDEST first, so the
 * recent ones — the only ones anyone looks at — are on the last page, and
 * reading page 1 alone showed a 2023 weigh-in as "latest". Pages until a short
 * one, or until a page repeats (a server ignoring `page` must not loop).
 */
async function fetchWeighIns(session, profileId, configModule, { maxPages = MAX_PAGES } = {}) {
	const all = [];
	let previousFirst = null;
	for (let page = 1; page <= maxPages; page += 1) {
		const rows = await fetchPage(session, profileId, configModule, page);
		const first = rows[0] ? `${rows[0].timestamp}:${rows[0].weightG}` : null;
		if (!rows.length || first === previousFirst) break;
		all.push(...rows);
		previousFirst = first;
		if (rows.length < PAGE_SIZE) break;
	}
	return all;
}

// ---------------------------------------------------------------------------
// Normalising a weigh-in
// ---------------------------------------------------------------------------

/** First finite number among these keys. */
function pick(record, keys) {
	for (const key of keys) {
		const raw = record?.[key];
		const value = typeof raw === "string" ? Number(raw) : raw;
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return null;
}

const round = (value, places = 1) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places);
/** A percentage VeSync may send as 0.215 or 21.5. */
const percent = (value) => (value === null || value <= 0 ? null : value <= 1 ? value * 100 : value);
const positive = (value) => (value === null || value <= 0 ? null : value);

function timestampOf(record) {
	const raw = pick(record, ["timestamp", "weighTime", "measureTime", "uploadTimestamp", "createTime"]);
	if (raw === null) return null;
	// Seconds or milliseconds, whichever VeSync sent.
	const ms = raw < 1e12 ? raw * 1000 : raw;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function weightKgOf(record) {
	const grams = pick(record, ["weightG", "weight_g"]);
	if (grams !== null) return grams / 1000;
	const kg = pick(record, ["weigh_kg", "weightKg", "weight_kg", "weight"]);
	if (kg !== null) return kg;
	const lb = pick(record, ["weigh_lb", "weightLb", "weight_lb"]);
	return lb === null ? null : lb * 0.45359237;
}

/**
 * One weigh-in in Athena's terms: metric, rounded, null where the scale did
 * not report it. Body composition other than weight needs bare feet on the
 * electrodes, so a socked weigh-in legitimately carries weight alone.
 */
function normalize(record) {
	const weightKg = positive(weightKgOf(record));
	const at = timestampOf(record);
	if (weightKg === null || !at) return null;
	const heightCm = positive(pick(record, ["heightCm", "height"]));
	const bmi = positive(pick(record, ["bmi", "BMI"])) ?? (heightCm ? weightKg / (heightCm / 100) ** 2 : null);
	const kgOrPercent = (kgKeys, percentKeys) => {
		const kg = positive(pick(record, kgKeys));
		if (kg !== null) return kg;
		const share = percent(pick(record, percentKeys));
		return share === null ? null : (share / 100) * weightKg;
	};
	return {
		at,
		weight_kg: round(weightKg, 2),
		bmi: round(bmi),
		body_fat_percent: round(percent(pick(record, ["bfr", "bodyFat", "bodyFatRate", "fatRate", "bodyFatPercent"]))),
		muscle_mass_kg: round(kgOrPercent(["muscleMass", "muscleKg", "muscle"], ["muscleRate", "musclePercent", "mr"])),
		skeletal_muscle_percent: round(percent(pick(record, ["skeletalMuscleRate", "skeletalMuscle", "smr"]))),
		fat_free_mass_kg: round(positive(pick(record, ["fatFreeWeight", "fatFreeMass", "ffm", "leanBodyMass", "lbm"]))),
		body_water_percent: round(percent(pick(record, ["water", "waterRate", "bodyWater", "bodyWaterRate", "tbw"]))),
		bone_mass_kg: round(kgOrPercent(["boneMass", "bone", "boneKg"], ["boneRate"])),
		protein_percent: round(percent(pick(record, ["protein", "proteinRate", "pp"]))),
		subcutaneous_fat_percent: round(percent(pick(record, ["subcutaneousFat", "subFat", "subcutaneousFatRate"]))),
		visceral_fat: round(positive(pick(record, ["visceralFat", "vfal", "visceralFatLevel"]))),
		bmr_kcal: round(positive(pick(record, ["bmr", "basalMetabolism", "basalMetabolicRate"])), 0),
		metabolic_age: round(positive(pick(record, ["metabolicAge", "bodyAge"])), 0),
		heart_rate: round(positive(pick(record, ["heartRate", "heart_rate"])), 0),
		manual: record.isManualInput === 1 || record.isManualInput === true,
		// The inputs Athena's own estimates are computed from
		// (services/bodyComposition.js), as the scale's profile had them on
		// the day of the weigh-in.
		height_cm: heightCm,
		impedance_ohm: positive(pick(record, ["impedance", "impedence"])),
		age: positive(pick(record, ["age"])),
		sex: sexOf(record.gender ?? record.sex),
	};
}

/** VeSync sends 1 for male and 0 for female; anything else is not guessed. */
function sexOf(raw) {
	const value = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
	if (value === 1 || value === "1" || value === "male" || value === "m") return "male";
	if (value === 0 || value === "0" || value === "female" || value === "f") return "female";
	return null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const cache = new Map(); // profileId -> { at, weighIns, scale }

async function linkFor(profileId) {
	const credential = await credentials.get(profileId, PROVIDER, { actor: "athena" });
	if (!credential || credential.kind !== "api_key" || !credential.refreshToken || !credential.displayName) {
		throw fail(`${LABEL} is not connected`, "not_connected", { reason: "absent" });
	}
	return credential;
}

/**
 * Run `read` with a live session, logging in again once if VeSync has let the
 * stored session lapse. A refused password marks the link needs_reauth — the
 * fix is re-running the script, and saying "broken" would be a lie.
 */
async function withSession(profileId, read) {
	const credential = await linkFor(profileId);
	const stored = credential.accessToken
		? { token: credential.accessToken, accountID: credential.externalAccountId || "", region: credential.tokenType || "US" }
		: null;
	if (stored) {
		try {
			return await read(stored);
		} catch (err) {
			if (err.code !== "session_rejected") throw err;
		}
	}
	let session;
	try {
		session = await login({ profileId, email: credential.displayName, password: credential.refreshToken, region: credential.tokenType || "US" });
	} catch (err) {
		if (err.code === "login_rejected") {
			await credentials.markNeedsReauth(credential.uuid, { actor: "connector", detail: err.message }).catch(() => {});
			throw Object.assign(err, { code: "not_connected", reason: "rejected", providerDetail: err.message });
		}
		throw err;
	}
	await credentials.updateTokens(credential.uuid, { accessToken: session.token, tokenType: session.region, actor: "refresh" });
	return read(session);
}

/** Every weigh-in VeSync has for the account holder (up to 100), newest first. */
async function listWeighIns(profileId, { days = 90 } = {}) {
	// Required lazily: consent pulls in the profile layer, which nothing that
	// only lists connectors (context.js) should have to load.
	if (!(await require("../consent").hasConsentForProfile(profileId, "health_data"))) {
		throw fail("Health data sharing has not been agreed to", "consent_required");
	}
	let entry = cache.get(profileId);
	if (!entry || Date.now() - entry.at > CACHE_MS) {
		const { weighIns, scale } = await withSession(profileId, async (session) => {
			const scale = await findScale(session, profileId);
			return { scale, weighIns: await fetchWeighIns(session, profileId, scale.configModule) };
		});
		entry = {
			at: Date.now(),
			scale: scale.name,
			// Three years: a year is the longest anyone can ask for, and a
			// calibration reference (a DEXA scan) can be older than that and
			// still needs the weigh-ins beside it.
			weighIns: weighIns.map(normalize).filter((w) => w && Date.now() - Date.parse(w.at) <= 3 * 366 * 86400_000).sort((a, b) => b.at.localeCompare(a.at)),
		};
		cache.set(profileId, entry);
	}
	const references = await require("../bodyCalibration").list(profileId);
	const { weighIns, calibration } = bodyComposition.enrich(entry.weighIns, references);
	const lookback = Math.max(1, Math.min(Number(days) || 90, 365));
	const after = new Date(Date.now() - lookback * 86400_000).toISOString();
	const recent = weighIns.filter((w) => w.at >= after).map(({ impedance_ohm, age, sex, height_cm, ...shown }) => shown);
	return Object.assign(recent, { calibration, references });
}

/** The dashboard's shape: newest reading, the history behind its trend, and the references correcting it. */
async function bodySummary(profileId) {
	const weighIns = await listWeighIns(profileId, { days: 90 });
	const { calibration, references } = weighIns;
	return { latest: weighIns[0] || null, weighIns: [...weighIns], calibration, references };
}

function invalidate(profileId) {
	cache.delete(profileId);
}

// ---------------------------------------------------------------------------
// Grounding + tools
// ---------------------------------------------------------------------------

const lb = (kg) => Math.round(kg * 2.20462 * 10) / 10;

function formatWeighIn(w) {
	const parts = [`${w.at.slice(0, 10)}: ${w.weight_kg} kg (${lb(w.weight_kg)} lb)`];
	if (w.body_fat_percent !== null) parts.push(`body fat ${w.body_fat_percent}%`);
	if (w.muscle_mass_kg !== null) parts.push(`muscle ${w.muscle_mass_kg} kg`);
	if (w.skeletal_muscle_kg != null) parts.push(`skeletal muscle ${w.skeletal_muscle_kg} kg`);
	if (w.fat_free_mass_kg != null) parts.push(`fat-free mass ${w.fat_free_mass_kg} kg`);
	if (w.bmi !== null) parts.push(`BMI ${w.bmi}`);
	if (w.body_water_percent !== null) parts.push(`water ${w.body_water_percent}%`);
	if (w.visceral_fat !== null) parts.push(`visceral fat ${w.visceral_fat}`);
	if (w.bone_mass_kg !== null) parts.push(`bone ${w.bone_mass_kg} kg`);
	if (w.bmr_kcal !== null) parts.push(`BMR ${w.bmr_kcal} kcal`);
	if (w.heart_rate !== null) parts.push(`heart rate ${w.heart_rate} bpm`);
	if (w.manual) parts.push("entered by hand");
	if (w.estimated?.length) parts.push(`Athena's estimates (published BIA equations, not the VeSync app): ${w.estimated.join(", ")}`);
	if (w.calibrated?.length) parts.push(`calibrated to a reference measurement: ${w.calibrated.join(", ")}`);
	return `- ${parts.join(", ")}`;
}

async function buildContext(profileId, { days = 30 } = {}) {
	const weighIns = await listWeighIns(profileId, { days });
	if (!weighIns.length) return `${LABEL}: no weigh-ins in the last ${days} days.`;
	return [`${LABEL} — weigh-ins from the last ${days} days, newest first:`, ...weighIns.slice(0, 20).map(formatWeighIn)].join("\n");
}

const FUNCTION_DECLARATIONS = [
	{
		name: "get_scale_weigh_ins",
		description:
			"Weigh-ins from the person's VeSync/Etekcity smart scale: weight plus body " +
			"composition (body fat %, muscle mass, BMI, body water, visceral fat, bone " +
			'mass, BMR) where the scale measured it. Use for "what do I weigh", "how ' +
			'much have I lost", "what\'s my body fat", or weight trend questions. Newest first.',
		parameters: {
			type: "OBJECT",
			properties: {
				days: { type: "NUMBER", description: "How many days back to look. Maximum 365; at most 100 weigh-ins." },
			},
		},
	},
];

async function executeTool(name, args = {}, { profileId }) {
	if (name === "get_scale_weigh_ins") return { weigh_ins: await listWeighIns(profileId, { days: args.days || 30 }) };
	throw new Error(`Unknown VeSync tool: ${name}`);
}

module.exports = {
	PROVIDER,
	LABEL,
	HOW_TO_LINK,
	HOW_TO_RELINK,
	matches,
	login,
	findScale,
	fetchWeighIns,
	normalize,
	listWeighIns,
	bodySummary,
	invalidate,
	buildContext,
	FUNCTION_DECLARATIONS,
	executeTool,
	terminalIdFor,
};
