const crypto = require("crypto");
const https = require("https");
const pool = require("../../helpers/db");
const credentials = require("../credentials");
const { DEFAULT_TZ } = require("../clock");

/**
 * Google Keep, read-only: the lists people share with Athena's own Google
 * account (EMAIL_ADDRESS) — the family grocery list first, so dinner ideas can
 * start from what is probably in the house instead of a recipe nobody can make.
 *
 * Consumer Keep has no API. This speaks the Android app's private protocol,
 * as gkeepapi does (github.com/kiwiz/gkeepapi), and can break whenever Google
 * changes it. The link is a `google_keep` api_key credential the owner adds
 * with scripts/addKeepLogin.js, stored on the profile of the person who
 * shared the list:
 *
 *   access_token_enc    the master token for Athena's account
 *   external_account_id Athena's address (also display_name)
 *
 * Two hops per session: the master token buys a short-lived OAuth token from
 * android.clients.google.com (which refuses connections that offer ALPN, so
 * this uses https.request, not fetch), and that token reads
 * www.googleapis.com/notes/v1/changes.
 *
 * Keep never says when an item was ticked, so Athena keeps her own history:
 * each fresh read of a food list is compared with the last one she saw
 * (athena_keep_snapshot) and every tick or untick is written down as
 * 'bought' or 'needed' with the time she noticed it (athena_keep_item_event,
 * migration 0081). The first read of a list only sets the baseline.
 */

const PROVIDER = "google_keep";
const LABEL = "Google Keep";
const HOW_TO_LINK = "that the owner can share a Google Keep list with Athena's own Google account and link it — there is no Connect button for it in the app";
const HOW_TO_RELINK = "Google refused Athena's saved Keep sign-in, and the owner re-running the Keep link script is the fix";
const TIMEOUT_MS = 12000;
const CACHE_MS = 5 * 60_000;
const AUTH_URL = "https://android.clients.google.com/auth";
const NOTES_URL = "https://www.googleapis.com/notes/v1/changes";
const SCOPES = "oauth2:https://www.googleapis.com/auth/memento https://www.googleapis.com/auth/reminders";
const KEEP_APP = "com.google.android.keep";
const CLIENT_SIG = "38918a453d07199354f8b19af05ec6562ced5788";
const MAX_PAGES = 20;
/** How far back an observed purchase still counts as "probably in the house". */
const BOUGHT_WITHIN_DAYS = 14;
/** Regulars shown in a prompt; a years-old list has hundreds. */
const MAX_USUAL = 150;

const KEYWORDS =
	/\b(dinner|supper|lunch|breakfast|grocery|groceries|shopping list|google keep|keep list|pantry|fridge|ingredients?|meal ?plan(ning)?|what (should|can|could) (we|i) (eat|make|cook|have)|what'?s for (dinner|lunch|supper)|cook tonight|recipes?)\b/i;

/** Which lists count as the food list. Other lists Athena can see stay out of a dinner prompt. */
const FOOD_LIST = /grocer|shopping|food|pantry|costco|kroger|walmart|aldi|publix|harris teeter|target|trader joe|whole foods|market/i;

function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

function fail(message, code = "provider_error", extra = {}) {
	return Object.assign(new Error(message), { code, ...extra });
}

/** gpsoauth's Android id: the same one keep_helper.py derives, so Google sees one device. */
function androidIdFor(email) {
	return crypto.createHash("sha256").update(String(email).toLowerCase()).digest("hex").slice(0, 16);
}

/** One request with no ALPN offered (see the header). Resolves { status, body }. */
function request(url, { method = "POST", headers = {}, body = "" } = {}) {
	return new Promise((resolve, reject) => {
		const req = https.request(url, { method, headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, timeout: TIMEOUT_MS }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("error", (err) => reject(fail(`Google Keep request failed: ${err.message}`)));
		req.end(body);
	});
}

/** The master token buys an OAuth token for Keep. Google's own error words on refusal. */
async function oauthToken(email, masterToken) {
	const form = new URLSearchParams({
		accountType: "HOSTED_OR_GOOGLE",
		Email: email,
		has_permission: "1",
		EncryptedPasswd: masterToken,
		service: SCOPES,
		source: "android",
		androidId: androidIdFor(email),
		app: KEEP_APP,
		client_sig: CLIENT_SIG,
		device_country: "us",
		operatorCountry: "us",
		lang: "en",
		sdk_version: "17",
		google_play_services_version: "240913000",
	}).toString();
	const { status, body } = await request(AUTH_URL, {
		headers: { "Accept-Encoding": "identity", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "GoogleAuth/1.4" },
		body: form,
	});
	const fields = Object.fromEntries(body.split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
	if (!fields.Auth) {
		const reason = fields.Error || `HTTP ${status}`;
		throw fail(`Google refused the Keep sign-in (${reason})`, /BadAuthentication|NeedsBrowser|DeviceManagementRequiredOrSyncDisabled/.test(reason) ? "login_rejected" : "provider_error");
	}
	return { token: fields.Auth, expiresAt: Number(fields.Expiry) * 1000 || Date.now() + 50 * 60_000 };
}

/** gkeepapi's timestamp format: microseconds, UTC. */
function keepTimestamp(date = new Date()) {
	return date.toISOString().replace("Z", "000Z");
}

/** Every node in the account, paging through `truncated` responses. */
async function syncAll(token) {
	const sessionId = `s--${Date.now()}--${crypto.randomInt(1_000_000_000, 9_999_999_999)}`;
	const nodes = new Map();
	let targetVersion;
	for (let page = 0; page < MAX_PAGES; page++) {
		const body = JSON.stringify({
			nodes: [],
			clientTimestamp: keepTimestamp(),
			requestHeader: {
				clientSessionId: sessionId,
				clientPlatform: "ANDROID",
				clientVersion: { major: "9", minor: "9", build: "9", revision: "9" },
				capabilities: ["NC", "PI", "LB", "AN", "SH", "DR", "TR", "IN", "SNB", "MI", "CO"].map((type) => ({ type })),
			},
			...(targetVersion ? { targetVersion } : {}),
		});
		const { status, body: text } = await request(NOTES_URL, {
			headers: { Authorization: `OAuth ${token}`, "Content-Type": "application/json" },
			body,
		});
		let reply;
		try {
			reply = JSON.parse(text);
		} catch {
			throw fail(`Google Keep returned HTTP ${status} without JSON`);
		}
		if (reply.error) throw fail(`Google Keep: ${reply.error.message || reply.error.code}`, reply.error.code === 401 ? "session_rejected" : "provider_error");
		for (const node of reply.nodes || []) nodes.set(node.id, node);
		targetVersion = reply.toVersion;
		if (!reply.truncated) return [...nodes.values()];
	}
	throw fail("Google Keep kept paging past the limit");
}

/**
 * Keep sends 1970-01-01 for "never" — and, it turns out, for every list item:
 * only the list itself carries real times (seen 2026-10-18 on a list with 338
 * items, all stamped 1970-01-01T00:00:00.002Z). Anything before 2000 is unknown.
 */
const KNOWN_AFTER = Date.parse("2000-01-01T00:00:00Z");
function when(value) {
	const at = Date.parse(value || "");
	return Number.isFinite(at) && at > KNOWN_AFTER ? new Date(at).toISOString() : null;
}

/** Raw nodes -> [{ id, title, updated, items: [{ text, checked, updated }] }], live lists only. */
function toLists(nodes) {
	const gone = (n) => n.timestamps?.trashed > "1970-01-01T00:00:00.000Z" || n.timestamps?.deleted > "1970-01-01T00:00:00.000Z";
	const lists = nodes.filter((n) => n.type === "LIST" && !n.isArchived && !gone(n));
	return lists.map((list) => ({
		id: list.id,
		title: list.title || "",
		updated: when(list.timestamps?.updated),
		items: nodes
			.filter((n) => n.type === "LIST_ITEM" && n.parentId === list.id && !gone(n))
			.sort((a, b) => Number(b.sortValue || 0) - Number(a.sortValue || 0))
			.map((n) => ({ text: String(n.text || "").trim(), checked: !!n.checked, updated: when(n.timestamps?.updated) }))
			.filter((i) => i.text),
	}));
}

async function linkFor(profileId) {
	const credential = await credentials.get(profileId, PROVIDER, { actor: "athena" });
	if (!credential || credential.kind !== "api_key" || !credential.accessToken || !credential.externalAccountId) {
		throw fail(`${LABEL} is not connected`, "not_connected", { reason: "absent" });
	}
	return credential;
}

const sessions = new Map(); // account email -> { token, expiresAt }
const cache = new Map(); // profileId -> { at, lists }

/** Every list shared with Athena's account that this profile linked, newest first. */
async function listLists(profileId) {
	const hit = cache.get(profileId);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.lists;
	const credential = await linkFor(profileId);
	const email = credential.externalAccountId;
	for (let attempt = 0; attempt < 2; attempt++) {
		let session = sessions.get(email);
		if (!session || session.expiresAt - Date.now() < 60_000) {
			try {
				session = await oauthToken(email, credential.accessToken);
			} catch (err) {
				if (err.code === "login_rejected") {
					await credentials.markNeedsReauth(credential.uuid, { actor: "connector", detail: err.message }).catch(() => {});
					throw Object.assign(err, { code: "not_connected", reason: "rejected", providerDetail: err.message });
				}
				throw err;
			}
			sessions.set(email, session);
		}
		try {
			const lists = toLists(await syncAll(session.token)).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
			cache.set(profileId, { at: Date.now(), lists });
			// History is a side benefit: a missing table (0081 not applied) or a
			// database blip must never cost them the list itself.
			await observe(profileId, lists).catch((err) => console.warn(`[googleKeep] history not recorded for ${profileId}: ${err.message}`));
			return lists;
		} catch (err) {
			if (err.code !== "session_rejected" || attempt) throw err;
			sessions.delete(email);
		}
	}
	throw fail("Google Keep refused a fresh session");
}

function invalidate(profileId) {
	cache.delete(profileId);
}

/** "Eggs " and "eggs" are one item. Fits athena_keep_item_event.item_key. */
function itemKey(text) {
	return String(text || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 255);
}

/** A list as item_key -> { t: text, c: 0|1 }. A duplicated item counts as ticked only when every copy is. */
function stateOf(list) {
	const state = {};
	for (const item of list.items) {
		const key = itemKey(item.text);
		if (!key) continue;
		const seen = state[key];
		state[key] = { t: seen ? seen.t : item.text.slice(0, 255), c: (seen ? seen.c : 1) && item.checked ? 1 : 0 };
	}
	return state;
}

/**
 * Last state seen -> this one: a tick is 'bought', an untick 'needed', and a
 * new unticked item 'needed' too. A new ticked item or a removed one says
 * nothing about when anything was bought, so it records nothing.
 */
function diffItems(before, after) {
	const events = [];
	for (const [key, now] of Object.entries(after)) {
		const was = before[key];
		if (was && !was.c && now.c) events.push({ key, text: now.t, event: "bought" });
		else if (was ? was.c && !now.c : !now.c) events.push({ key, text: now.t, event: "needed" });
	}
	return events;
}

/** Record what changed on each food list since the last read. Returns how many events were written. */
async function observe(profileId, lists, at = new Date()) {
	let recorded = 0;
	for (const list of lists.filter((l) => FOOD_LIST.test(l.title))) {
		const after = stateOf(list);
		const json = JSON.stringify(after);
		const [rows] = await pool.query("SELECT items, taken_at FROM athena_keep_snapshot WHERE profile_id = ? AND list_id = ?", [profileId, list.id]);
		if (!rows.length) {
			// First sight of this list: the baseline, nothing to compare with.
			await pool.query("INSERT IGNORE INTO athena_keep_snapshot (profile_id, list_id, items, taken_at) VALUES (?, ?, ?, ?)", [profileId, list.id, json, at]);
			continue;
		}
		const before = typeof rows[0].items === "string" ? JSON.parse(rows[0].items) : rows[0].items || {};
		const events = diffItems(before, after);
		if (!events.length && JSON.stringify(before) === json) continue;
		// Move the snapshot on only from the state just compared: if another
		// read got there first, it owns these changes and this one writes none.
		const [moved] = await pool.query(
			"UPDATE athena_keep_snapshot SET items = ?, taken_at = ? WHERE profile_id = ? AND list_id = ? AND taken_at = ?",
			[json, at, profileId, list.id, rows[0].taken_at]
		);
		if (!moved.affectedRows || !events.length) continue;
		await pool.query("INSERT INTO athena_keep_item_event (profile_id, list_id, item_key, item_text, event, observed_at) VALUES ?", [
			events.map((e) => [profileId, list.id, e.key, e.text, e.event, at]),
		]);
		recorded += events.length;
	}
	return recorded;
}

/** Tick/untick events on these lists in the last BOUGHT_WITHIN_DAYS, oldest first. */
async function recentEvents(profileId, lists, now = Date.now()) {
	if (!lists.length) return [];
	const [rows] = await pool.query(
		"SELECT list_id, item_key, item_text, event, observed_at FROM athena_keep_item_event " +
			"WHERE profile_id = ? AND list_id IN (?) AND observed_at >= ? ORDER BY observed_at, id",
		[profileId, lists.map((l) => l.id), new Date(now - BOUGHT_WITHIN_DAYS * 86400_000)]
	);
	return rows;
}

/**
 * The nightly backstop (src/jobs/nightly.js): one read for everyone whose list
 * Athena has already seen, so a tick is at most a day old when she notices it
 * even if nobody asked about dinner. No scheduler of its own.
 */
async function observeEveryone() {
	let rows;
	try {
		[rows] = await pool.query("SELECT DISTINCT profile_id FROM athena_keep_snapshot");
	} catch (err) {
		if (err.code === "ER_NO_SUCH_TABLE") return { profiles: 0, skipped: "migration 0081 not applied" };
		throw err;
	}
	let failed = 0;
	for (const { profile_id: profileId } of rows) {
		invalidate(profileId);
		await listLists(profileId).catch((err) => {
			failed += 1;
			console.warn(`[googleKeep] nightly read failed for ${profileId}: ${err.message}`);
		});
	}
	return { profiles: rows.length, failed };
}

/** Food lists only, split into what's needed and what Athena saw bought lately. */
async function groceries(profileId) {
	const lists = await listLists(profileId);
	const events = await recentEvents(profileId, lists.filter((l) => FOOD_LIST.test(l.title))).catch(() => []);
	return foodSummary(lists, Date.now(), events);
}

/** The local day Athena noticed something, e.g. "2026-10-16". */
function noticedDay(at) {
	return new Date(at).toLocaleDateString("en-CA", { timeZone: DEFAULT_TZ });
}

/**
 * What she saw ticked off within the window and is still ticked: the latest
 * event per item decides, so bought-then-needed-again drops out.
 */
function boughtObserved(list, events, since) {
	const latest = new Map();
	for (const e of events) {
		if (e.list_id === list.id && new Date(e.observed_at).getTime() >= since) latest.set(e.item_key, e);
	}
	const ticked = new Map(list.items.filter((i) => i.checked).map((i) => [itemKey(i.text), i.text]));
	return [...latest.values()]
		.filter((e) => e.event === "bought" && ticked.has(e.item_key))
		.sort((a, b) => new Date(b.observed_at) - new Date(a.observed_at))
		.map((e) => ({ text: ticked.get(e.item_key), day: noticedDay(e.observed_at) }));
}

function foodSummary(lists, now = Date.now(), events = []) {
	const since = now - BOUGHT_WITHIN_DAYS * 86400_000;
	return {
		lists: lists
			.filter((l) => FOOD_LIST.test(l.title))
			.map((l) => ({
				title: l.title,
				toBuy: l.items.filter((i) => !i.checked).map((i) => i.text),
				// Keep dates no item, so this is Athena's own observation of ticks.
				recentlyBought: boughtObserved(l, events, since),
				// A long-lived list is the household's buying history: ticked
				// items are untick-to-rebuy staples, not a record of the pantry.
				usuallyBuys: l.items.filter((i) => i.checked).map((i) => i.text),
			})),
		otherTitles: lists.filter((l) => !FOOD_LIST.test(l.title)).map((l) => l.title || "(untitled)"),
	};
}

async function buildContext(profileId) {
	return formatBlock(await groceries(profileId));
}

function formatBlock({ lists, otherTitles }) {
	if (!lists.length) {
		return `${LABEL}: no grocery or shopping list is shared with you${otherTitles.length ? ` (you can see: ${otherTitles.slice(0, 8).join(", ")})` : ""}. Say so rather than guessing what's in their kitchen.`;
	}
	const lines = [`${LABEL} — their shared grocery list${lists.length > 1 ? "s" : ""}, read just now:`];
	for (const list of lists) {
		lines.push(`"${list.title}"`);
		lines.push(list.toBuy.length ? `- Still to buy (they're OUT of these): ${list.toBuy.slice(0, 60).join("; ")}` : "- Nothing left to buy on it.");
		if (list.recentlyBought.length) {
			lines.push(
				`- Bought in the last ${BOUGHT_WITHIN_DAYS} days (observed: each date is when you noticed it ticked off on the list, ` +
					`not when they shopped, which may have been earlier; probably at home unless used up): ` +
					list.recentlyBought.slice(0, 60).map((i) => `${i.text} (noticed ${i.day})`).join("; ")
			);
		}
		if (list.usuallyBuys.length) {
			lines.push(
				`- What this household usually buys (ticked items they untick when they need them again; Keep doesn't say when, ` +
					`so these are their regulars, NOT proof they're in the kitchen now): ${list.usuallyBuys.slice(0, MAX_USUAL).join("; ")}` +
					(list.usuallyBuys.length > MAX_USUAL ? ` …and ${list.usuallyBuys.length - MAX_USUAL} more` : "")
			);
		}
	}
	lines.push(
		"For meal ideas: lean on what they usually buy (that's what they cook with and like), skip anything on the still-to-buy line, " +
			"say which ingredients you're assuming they have, and offer something quick when the day has been long. You can't see their " +
			"kitchen, so for a tired night offer two or three easy options and let them say what's actually there."
	);
	return lines.join("\n");
}

const FUNCTION_DECLARATIONS = [
	{
		name: "get_grocery_list",
		description:
			"The family's Google Keep grocery list shared with Athena: what is still to buy (they're out of it), what Athena " +
			"noticed being ticked off in the last two weeks, and the items they usually buy. Use for dinner ideas, \"what can we make\", or \"what's on the list\".",
		parameters: { type: "OBJECT", properties: {} },
	},
];

async function executeTool(name, _args = {}, { profileId }) {
	if (name === "get_grocery_list") return groceries(profileId);
	throw new Error(`Unknown Google Keep tool: ${name}`);
}

module.exports = {
	PROVIDER,
	LABEL,
	HOW_TO_LINK,
	HOW_TO_RELINK,
	matches,
	listLists,
	groceries,
	invalidate,
	observe,
	observeEveryone,
	recentEvents,
	itemKey,
	stateOf,
	diffItems,
	buildContext,
	toLists,
	oauthToken,
	syncAll,
	foodSummary,
	formatBlock,
	androidIdFor,
	FUNCTION_DECLARATIONS,
	executeTool,
};
