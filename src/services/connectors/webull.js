const crypto = require("crypto");
const pool = require("../../helpers/db");
const credentials = require("../credentials");

/**
 * Webull brokerage — balances, positions and orders, read-only.
 *
 * Webull OpenAPI (developer.webull.com) is an official API, but it has no
 * OAuth for individuals: the account holder applies for API access, generates
 * an App Key + App Secret, and every request is signed with them. If the
 * account has two-factor authentication on, a token must also be created and
 * approved in the Webull app (an SMS code, within five minutes) — that step
 * needs the person's phone, so it lives in scripts/addWebullLogin.js and is
 * never attempted here.
 *
 * The approved token has a fixed expiry (about 15 days), so the nightly job
 * renews it through Webull's refresh call a few days ahead (renewEveryone).
 * A renewed token is kept only when Webull says it is NORMAL; if Webull wants
 * a new SMS approval instead, nothing is faked — the old token keeps working
 * until it lapses, and on the last night before that the link is marked
 * needs_reauth so the Finance tab says why.
 *
 * The link is a `webull` api_key credential the owner adds with that script.
 * Its columns are used like this:
 *
 *   external_account_id the App Key
 *   access_token_enc    the App Secret (signs every request; never sent)
 *   refresh_token_enc   the 2FA access token, when the account has 2FA on
 *   expires_at          when that token lapses, as Webull reported it
 *   token_type          "production" or "sandbox"
 *   display_name        "Webull ····1234", the brokerage account number tail
 *
 * Nothing in this file can place, change or cancel an order. Those endpoints
 * are not named here, and the signer refuses any path outside READ_PATHS, so
 * a future caller cannot reach them by passing a path in. Trading is a
 * separate, owner-authorized change to the action layer.
 */

const PROVIDER = "webull";
const LABEL = "Webull";
const HOW_TO_LINK = "that the owner can link a Webull brokerage account for them — there is no Connect button for it in the app";
const HOW_TO_RELINK =
	"Webull refused the saved API key, or its sign-in token lapsed and Webull wanted a new text-message approval to renew it, and the owner re-running the Webull link script is the fix";
const TIMEOUT_MS = 12000;
// Webull allows balances/positions/orders 2 requests per 2 seconds per App
// Key in production. One cached read per five minutes stays far inside it.
const CACHE_MS = 5 * 60_000;
const SPACING_MS = 1100;
// Renew once the token is this close to lapsing: three nightly tries.
const RENEW_WITHIN_MS = 3 * 86400_000;
// Closer than this, tonight's run is the last one before it lapses.
const LAST_NIGHT_MS = 30 * 3600_000;
// In chat, mention a token that a night's renewal has already missed.
const WARN_WITHIN_MS = 2 * 86400_000;

const HOSTS = { production: "api.webull.com", sandbox: "api.sandbox.webull.com" };

// The only paths this connector may sign. Reads, the two token calls the link
// script needs, and the refresh the nightly renewal uses.
const READ_PATHS = new Set([
	"/trading/accounts/list",
	"/trading/assets/balances/get",
	"/trading/assets/positions/list",
	"/trading/orders/open-orders/list",
	"/trading/orders/historical-orders/list",
	"/auth/tokens/create",
	"/auth/tokens/check",
	"/openapi/auth/token/refresh",
]);

const KEYWORDS =
	/\b(webull|brokerage|portfolio|my stocks?|my shares|my positions?|holdings|buying power|stock market|investments?|invested|my account balance|net worth|unrealized|p&l|profit and loss|open orders?|my trades?|day trades?)\b/i;

function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

function fail(message, code = "provider_error", extra = {}) {
	return Object.assign(new Error(message), { code, ...extra });
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Webull's request signature (developer.webull.com → Authentication →
 * Signature). The docs describe HMAC-SHA1 with an MD5 body digest and give a
 * worked example the tests reproduce; Webull's own Python SDK now sends
 * HMAC-SHA256 with a SHA-256 body digest, and the server takes whichever
 * `x-signature-algorithm` names. SHA-256 is the default because it is what
 * the SDK ships; WEBULL_SIGNATURE_ALGORITHM=HMAC-SHA1 falls back.
 *
 *   str1 = query params + the six signing headers, sorted, name=value&...
 *   str2 = uppercase hex digest of the compact JSON body (only with a body)
 *   sign = base64(HMAC(secret + "&", urlencode(path & str1 [& str2])))
 */
function signature({ path, query = {}, headers, body, secret, algorithm }) {
	const params = { ...query, ...headers };
	const str1 = Object.keys(params)
		.sort()
		.map((k) => `${k}=${params[k]}`)
		.join("&");
	const sha256 = algorithm === "HMAC-SHA256";
	const parts = [path, str1];
	if (body !== undefined) {
		parts.push(crypto.createHash(sha256 ? "sha256" : "md5").update(body).digest("hex").toUpperCase());
	}
	return crypto
		.createHmac(sha256 ? "sha256" : "sha1", `${secret}&`)
		.update(encodeURIComponent(parts.join("&")))
		.digest("base64");
}

function algorithmFromEnv() {
	return process.env.WEBULL_SIGNATURE_ALGORITHM === "HMAC-SHA1" ? "HMAC-SHA1" : "HMAC-SHA256";
}

/** ISO 8601 to the second, UTC — the only form Webull accepts. */
function timestamp(date = new Date()) {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * One signed request. `link` is { appKey, appSecret, token, environment }.
 * Returns parsed JSON; throws a typed error the context layer can explain.
 */
async function request(link, method, path, { query = {}, body } = {}) {
	if (!READ_PATHS.has(path)) throw fail(`Webull path not allowed: ${path}`, "forbidden_path");
	const host = HOSTS[link.environment === "sandbox" ? "sandbox" : "production"];
	const algorithm = algorithmFromEnv();
	const signing = {
		"x-app-key": link.appKey,
		"x-signature-algorithm": algorithm,
		"x-signature-version": "1.0",
		"x-signature-nonce": crypto.randomUUID().replace(/-/g, ""),
		"x-timestamp": timestamp(),
	};
	const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ""));
	const bodyText = body === undefined ? undefined : JSON.stringify(body);
	const headers = {
		...signing,
		"x-version": "v3",
		"x-signature": signature({ path, query: clean, headers: { ...signing, host }, body: bodyText, secret: link.appSecret, algorithm }),
		Accept: "application/json",
	};
	if (link.token) headers["x-access-token"] = link.token;
	if (bodyText !== undefined) headers["Content-Type"] = "application/json";
	const qs = new URLSearchParams(clean).toString();
	let response;
	try {
		response = await fetch(`https://${host}${path}${qs ? `?${qs}` : ""}`, {
			method,
			headers,
			body: bodyText,
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		throw fail(`Webull request failed: ${err.message}`);
	}
	const data = await response.json().catch(() => null);
	if (!response.ok) {
		const detail = data?.message || data?.msg || data?.error_code || `HTTP ${response.status}`;
		const code = response.status === 401 || response.status === 403 ? "auth_rejected" : response.status === 429 ? "rate_limited" : "provider_error";
		throw fail(`Webull: ${detail}`, code, { providerStatus: response.status, providerDetail: String(detail) });
	}
	if (data === null) throw fail("Webull sent a response that was not JSON");
	return data;
}

// ---------------------------------------------------------------------------
// 2FA token (create/check for the link script, refresh for the nightly job)
// ---------------------------------------------------------------------------

/** Webull's token reply, with the expiry under whichever name it used. */
function tokenOf(data) {
	return { token: data?.token || null, status: data?.status || null, expiresAt: Number(data?.expires_at ?? data?.expires) || null };
}

async function createToken(link) {
	return tokenOf(await request(link, "POST", "/auth/tokens/create", { body: link.token ? { token: link.token } : {} }));
}

async function checkToken(link, token) {
	return tokenOf(await request(link, "POST", "/auth/tokens/check", { body: { token } }));
}

/**
 * Webull's token refresh, as the official SDK sends it (RefreshTokenRequest,
 * v3). The public docs don't describe the reply, so renew() checks it.
 */
async function refreshToken(link) {
	return tokenOf(await request(link, "POST", "/openapi/auth/token/refresh", { body: { token: link.token } }));
}

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

/** Webull sends every number as a string ("485705.0", "2.3E8"). */
function num(raw) {
	if (raw === null || raw === undefined || raw === "") return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

const round2 = (value) => (value === null ? null : Math.round(value * 100) / 100);

function normalizeAccount(a) {
	const number = String(a.account_number || "");
	return {
		id: String(a.account_id),
		label: a.account_label || a.account_class || a.account_type || "Account",
		type: a.account_type || null,
		class: a.account_class || null,
		// Never the whole number: the tail is enough to tell two apart.
		number_tail: number ? number.slice(-4) : null,
	};
}

function normalizeBalance(b) {
	const usd = (b.account_currency_assets || []).find((c) => c.currency === (b.total_asset_currency || "USD")) || b.account_currency_assets?.[0] || {};
	return {
		currency: b.total_asset_currency || usd.currency || "USD",
		net_value: num(b.total_net_liquidation_value),
		market_value: num(b.total_market_value),
		cash: num(b.total_cash_balance),
		settled_cash: num(usd.settled_cash),
		buying_power: num(usd.buying_power),
		day_pl: num(b.total_day_profit_loss),
		open_pl: num(b.total_unrealized_profit_loss),
		// "UNLIMITED" or a count — the pattern-day-trader allowance.
		day_trades_left: b.day_trades_left ?? null,
	};
}

function normalizePosition(p) {
	const quantity = num(p.quantity);
	const last = num(p.last_price);
	const cost = num(p.cost_price);
	const multiplier = p.instrument_type === "OPTION" ? num(p.legs?.[0]?.option_contract_multiplier) || 100 : 1;
	const value = quantity !== null && last !== null ? quantity * last * multiplier : null;
	const basis = quantity !== null && cost !== null ? quantity * cost * multiplier : null;
	const pl = num(p.unrealized_profit_loss);
	return {
		symbol: p.symbol || p.legs?.[0]?.symbol || "?",
		type: p.instrument_type || null,
		strategy: p.option_strategy && p.option_strategy !== "SINGLE" ? p.option_strategy : null,
		quantity,
		last_price: last,
		cost_price: cost,
		market_value: round2(value),
		unrealized_pl: pl,
		unrealized_pl_percent: pl !== null && basis ? round2((pl / Math.abs(basis)) * 100) : null,
		legs: (p.legs || []).filter((l) => l.option_type).map((l) => ({
			symbol: l.symbol,
			quantity: num(l.quantity),
			option_type: l.option_type,
			strike: num(l.option_exercise_price),
			expires: l.option_expire_date || null,
		})),
	};
}

/** Webull groups orders (a combo is several); Athena shows each one. */
function normalizeOrders(groups) {
	const rows = [];
	for (const group of groups || []) {
		for (const o of group.orders || []) {
			rows.push({
				id: o.order_id || o.client_order_id || null,
				symbol: o.symbol || o.legs?.[0]?.symbol || "?",
				side: o.side || null,
				type: o.order_type || null,
				status: o.status || null,
				quantity: num(o.total_quantity),
				filled_quantity: num(o.filled_quantity),
				filled_price: num(o.filled_price),
				limit_price: num(o.limit_price),
				stop_price: num(o.stop_price),
				time_in_force: o.time_in_force || null,
				placed_at: o.place_time_at || (num(o.place_time) ? new Date(num(o.place_time)).toISOString() : null),
				filled_at: o.filled_time_at || (num(o.filled_time) ? new Date(num(o.filled_time)).toISOString() : null),
			});
		}
	}
	return rows.sort((a, b) => String(b.placed_at || "").localeCompare(String(a.placed_at || "")));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function linkFor(profileId) {
	const credential = await credentials.get(profileId, PROVIDER, { actor: "athena" });
	if (!credential || credential.kind !== "api_key" || !credential.accessToken || !credential.externalAccountId) {
		throw fail(`${LABEL} is not connected`, "not_connected", { reason: "absent" });
	}
	return {
		uuid: credential.uuid,
		appKey: credential.externalAccountId,
		appSecret: credential.accessToken,
		token: credential.refreshToken || null,
		tokenExpiresAt: credential.expiresAt ? new Date(credential.expiresAt).getTime() || null : null,
		environment: credential.tokenType === "sandbox" ? "sandbox" : "production",
	};
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Paged order list, capped so one read can never run away. */
async function pagedOrders(link, path, query, maxPages = 5) {
	const groups = [];
	let key;
	for (let page = 0; page < maxPages; page += 1) {
		const data = await request(link, "GET", path, { query: { ...query, pagination_key: key } });
		groups.push(...(Array.isArray(data) ? data : data?.data || []));
		key = Array.isArray(data) ? null : data?.pagination_key;
		if (!key) break;
		await pause(SPACING_MS);
	}
	return groups;
}

/** Everything for one account, spaced to stay under 2 requests / 2 s. */
async function readAccount(link, account, { historyDays }) {
	const query = { account_id: account.id };
	const balance = normalizeBalance(await request(link, "GET", "/trading/assets/balances/get", { query }));
	await pause(SPACING_MS);
	const positions = (await request(link, "GET", "/trading/assets/positions/list", { query }).then((d) => (Array.isArray(d) ? d : d?.data || []))).map(normalizePosition);
	await pause(SPACING_MS);
	const open = normalizeOrders(await pagedOrders(link, "/trading/orders/open-orders/list", query));
	await pause(SPACING_MS);
	const start = new Date(Date.now() - historyDays * 86400_000).toISOString();
	const recent = normalizeOrders(await pagedOrders(link, "/trading/orders/historical-orders/list", { ...query, start_time: start, end_time: new Date().toISOString() }));
	positions.sort((a, b) => (b.market_value ?? 0) - (a.market_value ?? 0));
	return { ...account, balance, positions, open_orders: open, recent_orders: recent.slice(0, 50) };
}

/**
 * A refused key or token means the owner has to act; say needs_reauth rather
 * than "broken". Anything else (5xx, timeout, 429) is passed through.
 */
async function withLink(profileId, read) {
	const link = await linkFor(profileId);
	try {
		return await read(link);
	} catch (err) {
		if (err.code === "auth_rejected") {
			await credentials.markNeedsReauth(link.uuid, { actor: "connector", detail: err.message }).catch(() => {});
			throw Object.assign(err, { code: "not_connected", reason: "rejected" });
		}
		throw err;
	}
}

const cache = new Map(); // profileId -> { at, snapshot }

/**
 * The whole brokerage picture: every account Webull lists, each with its
 * balance, positions, open orders and the last 30 days of orders.
 */
async function snapshot(profileId, { fresh = false } = {}) {
	const entry = cache.get(profileId);
	if (!fresh && entry && Date.now() - entry.at < CACHE_MS) return entry.snapshot;
	const result = await withLink(profileId, async (link) => {
		const listed = await request(link, "GET", "/trading/accounts/list");
		const accounts = (Array.isArray(listed) ? listed : listed?.data || []).map(normalizeAccount);
		const read = [];
		for (const account of accounts) {
			await pause(SPACING_MS);
			read.push(await readAccount(link, account, { historyDays: 30 }));
		}
		return { environment: link.environment, token_expires_at: link.tokenExpiresAt ? new Date(link.tokenExpiresAt).toISOString() : null, accounts: read };
	});
	const totals = summarize(result.accounts);
	const snap = { ...result, totals, checked_at: new Date().toISOString() };
	cache.set(profileId, { at: Date.now(), snapshot: snap });
	return snap;
}

/** Sums across accounts, in the one currency they share (else null). */
function summarize(accounts) {
	const currencies = new Set(accounts.map((a) => a.balance.currency));
	if (currencies.size !== 1) return null;
	const sum = (key) => {
		const values = accounts.map((a) => a.balance[key]).filter((v) => v !== null);
		return values.length ? round2(values.reduce((t, v) => t + v, 0)) : null;
	};
	return {
		currency: [...currencies][0],
		net_value: sum("net_value"),
		market_value: sum("market_value"),
		cash: sum("cash"),
		buying_power: sum("buying_power"),
		day_pl: sum("day_pl"),
		open_pl: sum("open_pl"),
	};
}

function invalidate(profileId) {
	cache.delete(profileId);
}

// ---------------------------------------------------------------------------
// Token renewal (nightly)
// ---------------------------------------------------------------------------

function saveToken(link, token, expiresAt) {
	return credentials.updateTokens(link.uuid, {
		accessToken: link.appSecret,
		refreshToken: token,
		expiresAt: expiresAt ? new Date(expiresAt) : undefined,
		actor: "webull-renew",
	});
}

/**
 * Keep one person's 2FA token from lapsing. Does nothing until the token is
 * within RENEW_WITHIN_MS of its expiry (a link stored without one has it
 * looked up first). Never asks for an SMS approval: if Webull won't hand back
 * a NORMAL token, the current one is left alone, and only on the last night
 * before it lapses is the link marked needs_reauth. (Marking it sooner would
 * cut reads off early: markNeedsReauth clears the App Secret.)
 */
async function renew(profileId, { now = Date.now() } = {}) {
	const link = await linkFor(profileId);
	if (!link.token) return { renewed: false, reason: "no_2fa" };
	let expiresAt = link.tokenExpiresAt;
	if (!expiresAt) {
		let current;
		try {
			current = await checkToken(link, link.token);
		} catch (err) {
			if (err.code !== "auth_rejected") throw err;
			current = { status: null, detail: err.message };
		}
		if (current.status !== "NORMAL") {
			await credentials.markNeedsReauth(link.uuid, { actor: "webull-renew", detail: current.detail || `Webull says the sign-in token is ${current.status || "unknown"}` });
			invalidate(profileId);
			return { renewed: false, reason: "rejected" };
		}
		if (!current.expiresAt) return { renewed: false, reason: "no_expiry" };
		expiresAt = current.expiresAt;
		await saveToken(link, link.token, expiresAt);
		if (expiresAt - now > RENEW_WITHIN_MS) return { renewed: false, reason: "not_due", expiresAt };
		await pause(SPACING_MS);
	}
	if (expiresAt - now > RENEW_WITHIN_MS) return { renewed: false, reason: "not_due", expiresAt };

	let why;
	try {
		let next = await refreshToken(link);
		if (next.token && next.status !== "NORMAL") {
			await pause(SPACING_MS);
			const checked = await checkToken(link, next.token);
			next = { token: next.token, status: checked.status, expiresAt: checked.expiresAt || next.expiresAt };
		}
		if (next.token && next.status === "NORMAL") {
			await saveToken(link, next.token, next.expiresAt);
			invalidate(profileId);
			return { renewed: true, expiresAt: next.expiresAt };
		}
		why = next.status === "PENDING" ? "Webull asked for a new text-message approval" : `Webull returned token status ${next.status || "none"}`;
	} catch (err) {
		// A refused refresh doesn't mean the current token is dead; reads will
		// say so themselves if it is.
		why = err.message;
	}
	const lapses = new Date(expiresAt).toISOString();
	if (expiresAt - now > LAST_NIGHT_MS) {
		console.warn(`[webull] token renewal for ${profileId} did not succeed (${why}); it lapses ${lapses}, retrying tomorrow night`);
		return { renewed: false, reason: "needs_approval", expiresAt };
	}
	await credentials.markNeedsReauth(link.uuid, {
		actor: "webull-renew",
		detail: `Webull 2FA token lapses ${lapses} and could not be renewed automatically (${why}). The owner re-running scripts/addWebullLogin.js approves a new one.`,
	});
	invalidate(profileId);
	return { renewed: false, reason: "needs_approval", flagged: true, expiresAt };
}

/** Nightly: every live Webull link. One failure never stops the rest. */
async function renewEveryone() {
	const [rows] = await pool.query("SELECT DISTINCT profile_id FROM user_credential WHERE provider = 'webull' AND status = 'active'");
	let renewed = 0, waiting = 0, flagged = 0, failed = 0;
	for (const { profile_id: profileId } of rows) {
		try {
			const result = await renew(Number(profileId));
			if (result.renewed) renewed += 1;
			else if (result.flagged || result.reason === "rejected") flagged += 1;
			else if (result.reason === "needs_approval") waiting += 1;
		} catch (err) {
			failed += 1;
			console.warn("[webull] nightly token renewal failed:", profileId, err.message);
		}
	}
	return { profiles: rows.length, renewed, waiting, flagged, failed };
}

// ---------------------------------------------------------------------------
// Grounding + tools
// ---------------------------------------------------------------------------

const money = (v, currency = "USD") => (v === null || v === undefined ? "unknown" : `${v < 0 ? "-" : ""}${currency === "USD" ? "$" : `${currency} `}${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function formatAccount(a) {
	const b = a.balance;
	const lines = [
		`${a.label}${a.number_tail ? ` (····${a.number_tail})` : ""}: net value ${money(b.net_value, b.currency)}, cash ${money(b.cash, b.currency)}, buying power ${money(b.buying_power, b.currency)}, today ${money(b.day_pl, b.currency)}, open P&L ${money(b.open_pl, b.currency)}, day trades left ${b.day_trades_left ?? "unknown"}`,
	];
	for (const p of a.positions.slice(0, 25)) {
		lines.push(
			`  - ${p.symbol}${p.type && p.type !== "STOCK" ? ` (${p.type.toLowerCase()})` : ""}: ${p.quantity ?? "?"} @ ${money(p.last_price)} = ${money(p.market_value)}, cost ${money(p.cost_price)}, unrealized ${money(p.unrealized_pl)}${p.unrealized_pl_percent !== null ? ` (${p.unrealized_pl_percent}%)` : ""}`
		);
	}
	if (a.positions.length > 25) lines.push(`  …and ${a.positions.length - 25} more positions`);
	for (const o of a.open_orders.slice(0, 10)) lines.push(`  open order: ${o.side} ${o.quantity} ${o.symbol} ${o.type}${o.limit_price !== null ? ` @ ${money(o.limit_price)}` : ""} (${o.status})`);
	return lines.join("\n");
}

async function buildContext(profileId) {
	const snap = await snapshot(profileId);
	const lapsing =
		snap.token_expires_at && Date.parse(snap.token_expires_at) - Date.now() < WARN_WITHIN_MS
			? `Webull's sign-in approval runs out ${snap.token_expires_at} and the nightly renewal hasn't managed to renew it; if it lapses, the owner re-running the Webull link script fixes it.`
			: null;
	if (!snap.accounts.length) return [`${LABEL}: the linked API key lists no brokerage accounts.`, lapsing].filter(Boolean).join("\n");
	return [
		`${LABEL} brokerage, read-only (checked ${snap.checked_at}). Figures are Webull's own. You cannot place, change or cancel orders, and you must not give personalized buy/sell advice as if licensed:`,
		...snap.accounts.map(formatAccount),
		lapsing,
	].filter(Boolean).join("\n");
}

const FUNCTION_DECLARATIONS = [
	{
		name: "get_brokerage_portfolio",
		description:
			"The person's Webull brokerage accounts, read-only: balance, cash, buying power, " +
			"today's and open profit/loss, every position (symbol, quantity, price, cost, " +
			"unrealized gain), open orders, and orders from the last 30 days. Use for " +
			'"how are my stocks doing", "what do I own", "how much buying power do I have". ' +
			"Cannot trade.",
		parameters: { type: "OBJECT", properties: {} },
	},
];

async function executeTool(name, _args, { profileId }) {
	if (name === "get_brokerage_portfolio") return await snapshot(profileId);
	throw new Error(`Unknown Webull tool: ${name}`);
}

module.exports = {
	PROVIDER,
	LABEL,
	HOW_TO_LINK,
	HOW_TO_RELINK,
	READ_PATHS,
	matches,
	signature,
	request,
	createToken,
	checkToken,
	refreshToken,
	renew,
	renewEveryone,
	normalizeAccount,
	normalizeBalance,
	normalizePosition,
	normalizeOrders,
	snapshot,
	invalidate,
	buildContext,
	FUNCTION_DECLARATIONS,
	executeTool,
};
