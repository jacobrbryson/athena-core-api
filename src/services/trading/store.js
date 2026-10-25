/**
 * MySQL persistence for the trading module (migration 0092_trading). Every
 * query is scoped to the caller's profile. Signal events are append-only;
 * nothing here rewrites an earlier assessment.
 */

const crypto = require("node:crypto");
const uuidv4 = () => crypto.randomUUID();
const pool = require("../../helpers/db");
const { etParts, settlementDate } = require("./marketClock");
const lifecycle = require("./lifecycle");

const DEFAULTS = Object.freeze({
	starting_capital: 423,
	max_risk_per_trade: 4,
	max_daily_loss: 8,
	max_trades_per_day: 2,
	min_reward_risk: 2,
	allow_fractional: 0,
});

const num = (x) => (x === null || x === undefined ? null : Number(x));
const json = (x) => (x === null || x === undefined ? null : typeof x === "string" ? JSON.parse(x) : x);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const dateOnly = (d) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);

// ---------------------------------------------------------------------------
// Account and cash
// ---------------------------------------------------------------------------

function shapeAccount(r) {
	if (!r) return null;
	return {
		id: r.id, uuid: r.uuid, broker: r.broker, account_type: r.account_type,
		starting_capital: num(r.starting_capital), max_risk_per_trade: num(r.max_risk_per_trade), max_daily_loss: num(r.max_daily_loss),
		max_trades_per_day: Number(r.max_trades_per_day), min_reward_risk: num(r.min_reward_risk), allow_fractional: !!r.allow_fractional,
		costs: { commission_per_order: num(r.commission_per_order), sec_fee_rate: num(r.sec_fee_rate), taf_fee_per_share: num(r.taf_fee_per_share), slippage_per_share: num(r.slippage_per_share) },
		alerts_enabled: !!r.alerts_enabled,
		broker_cash: num(r.broker_cash), broker_settled_cash: num(r.broker_settled_cash), broker_checked_at: iso(r.broker_checked_at),
	};
}

async function getAccount(profileId) {
	const [rows] = await pool.query("SELECT * FROM trading_accounts WHERE profile_id = ? LIMIT 1", [profileId]);
	return shapeAccount(rows[0]);
}

/** The person's account, created with the defaults (and an opening cash entry) on first use. */
async function ensureAccount(profileId) {
	const existing = await getAccount(profileId);
	if (existing) return existing;
	const today = etParts().date;
	await pool.query(
		`INSERT IGNORE INTO trading_accounts (uuid, profile_id, starting_capital, max_risk_per_trade, max_daily_loss, max_trades_per_day, min_reward_risk, allow_fractional)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[uuidv4(), profileId, DEFAULTS.starting_capital, DEFAULTS.max_risk_per_trade, DEFAULTS.max_daily_loss, DEFAULTS.max_trades_per_day, DEFAULTS.min_reward_risk, DEFAULTS.allow_fractional]
	);
	const account = await getAccount(profileId);
	const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM trading_cash_ledger WHERE account_id = ?", [account.id]);
	if (!n) await addLedger(account.id, [{ kind: "opening", amount: account.starting_capital, trade_date: today, settles_on: today, note: "Starting capital (settled)" }]);
	return account;
}

const EDITABLE = {
	max_risk_per_trade: [0.01, 10_000], max_daily_loss: [0.01, 50_000], max_trades_per_day: [0, 20], min_reward_risk: [0.5, 10],
	commission_per_order: [0, 100], sec_fee_rate: [0, 0.001], taf_fee_per_share: [0, 0.01], slippage_per_share: [0, 5],
};

/** Validated settings change. Returns { account } or { error }. */
async function updateAccount(profileId, patch) {
	const account = await ensureAccount(profileId);
	const sets = [];
	const values = [];
	for (const [key, [min, max]] of Object.entries(EDITABLE)) {
		if (patch[key] === undefined) continue;
		const v = Number(patch[key]);
		if (!Number.isFinite(v) || v < min || v > max) return { error: `${key} must be between ${min} and ${max}` };
		sets.push(`${key} = ?`);
		values.push(key === "max_trades_per_day" ? Math.round(v) : v);
	}
	for (const key of ["allow_fractional", "alerts_enabled"]) {
		if (patch[key] === undefined) continue;
		sets.push(`${key} = ?`);
		values.push(patch[key] ? 1 : 0);
	}
	if (sets.length) await pool.query(`UPDATE trading_accounts SET ${sets.join(", ")} WHERE id = ?`, [...values, account.id]);
	return { account: await getAccount(profileId) };
}

async function recordBrokerCheck(accountId, { cash, settled_cash }) {
	await pool.query("UPDATE trading_accounts SET broker_cash = ?, broker_settled_cash = ?, broker_checked_at = UTC_TIMESTAMP(3) WHERE id = ?", [cash, settled_cash, accountId]);
}

async function ledger(accountId) {
	const [rows] = await pool.query("SELECT * FROM trading_cash_ledger WHERE account_id = ? ORDER BY trade_date, id", [accountId]);
	return rows.map((r) => ({ id: r.id, kind: r.kind, amount: num(r.amount), trade_date: dateOnly(r.trade_date), settles_on: dateOnly(r.settles_on), position_id: r.position_id, note: r.note, created_at: iso(r.created_at) }));
}

async function addLedger(accountId, entries, conn = pool) {
	for (const e of entries) {
		await conn.query("INSERT INTO trading_cash_ledger (account_id, kind, amount, trade_date, settles_on, position_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[accountId, e.kind, e.amount, e.trade_date, e.settles_on, e.position_id || null, e.note || null]);
	}
}

// ---------------------------------------------------------------------------
// Strategy versions
// ---------------------------------------------------------------------------

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
	return JSON.stringify(value);
}
const hashParams = (params) => crypto.createHash("sha256").update(canonical(params)).digest("hex");

/** The id of the version with exactly these parameters, creating the next version number if new. */
async function ensureStrategyVersion(key, params, description = null) {
	const hash = hashParams(params);
	const [found] = await pool.query("SELECT id, version, status FROM trading_strategy_versions WHERE strategy_key = ? AND params_hash = ?", [key, hash]);
	if (found[0]) return { id: found[0].id, version: found[0].version, status: found[0].status, params_hash: hash };
	const [[{ next }]] = await pool.query("SELECT COALESCE(MAX(version), 0) + 1 AS next FROM trading_strategy_versions WHERE strategy_key = ?", [key]);
	await pool.query("INSERT IGNORE INTO trading_strategy_versions (strategy_key, version, params_json, params_hash, description) VALUES (?, ?, ?, ?, ?)",
		[key, next, JSON.stringify(params), hash, description]);
	return ensureStrategyVersion(key, params, description);
}

async function strategyVersions(key) {
	const [rows] = await pool.query("SELECT id, version, params_hash, description, status, created_at FROM trading_strategy_versions WHERE strategy_key = ? ORDER BY version DESC", [key]);
	return rows.map((r) => ({ ...r, created_at: iso(r.created_at) }));
}

// ---------------------------------------------------------------------------
// Watchlist, candles, snapshots
// ---------------------------------------------------------------------------

async function saveWatchlist(profileId, date, rows) {
	for (const r of rows) {
		await pool.query(
			`INSERT INTO trading_watchlists (profile_id, session_date, symbol, company_name, \`rank\`, scanner_score, reasons_json, source, removed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
			 ON DUPLICATE KEY UPDATE company_name = VALUES(company_name), \`rank\` = VALUES(\`rank\`), scanner_score = VALUES(scanner_score), reasons_json = VALUES(reasons_json), removed_at = NULL`,
			[profileId, date, r.symbol, r.company_name || null, r.rank ?? null, r.score ?? null, JSON.stringify(r.reasons || []), r.source || "scanner"]
		);
	}
	const keep = rows.map((r) => r.symbol);
	await pool.query(
		`UPDATE trading_watchlists SET removed_at = UTC_TIMESTAMP(3) WHERE profile_id = ? AND session_date = ? AND source = 'scanner' AND pinned = 0 AND removed_at IS NULL${keep.length ? " AND symbol NOT IN (?)" : ""}`,
		keep.length ? [profileId, date, keep] : [profileId, date]
	);
}

async function addManualWatch(profileId, date, symbol) {
	await pool.query(
		`INSERT INTO trading_watchlists (profile_id, session_date, symbol, source, pinned) VALUES (?, ?, ?, 'manual', 1)
		 ON DUPLICATE KEY UPDATE pinned = 1, removed_at = NULL`, [profileId, date, symbol]);
}

async function removeWatch(profileId, date, symbol) {
	await pool.query("UPDATE trading_watchlists SET removed_at = UTC_TIMESTAMP(3), pinned = 0 WHERE profile_id = ? AND session_date = ? AND symbol = ?", [profileId, date, symbol]);
}

async function watchlist(profileId, date) {
	const [rows] = await pool.query(
		"SELECT * FROM trading_watchlists WHERE profile_id = ? AND session_date = ? AND removed_at IS NULL ORDER BY pinned DESC, `rank` IS NULL, `rank`, symbol", [profileId, date]);
	return rows.map((r) => ({ symbol: r.symbol, company_name: r.company_name, rank: r.rank, score: num(r.scanner_score), reasons: json(r.reasons_json) || [], source: r.source, pinned: !!r.pinned, added_at: iso(r.added_at) }));
}

async function lastScanAt(profileId, date) {
	const [[row]] = await pool.query("SELECT MAX(added_at) AS at FROM trading_watchlists WHERE profile_id = ? AND session_date = ? AND source = 'scanner'", [profileId, date]);
	return row?.at ? new Date(row.at).getTime() : 0;
}

/** Closed candles only; duplicates are ignored (a candle never changes once closed). */
async function saveCandles(symbol, timeframe, feed, bars) {
	if (!bars.length) return;
	const rows = bars.map((b) => [symbol, timeframe, feed, new Date(b.t), b.o, b.h, b.l, b.c, Math.round(b.v), b.vw ?? null, b.n ?? null]);
	for (let i = 0; i < rows.length; i += 500) {
		await pool.query("INSERT IGNORE INTO trading_candles (symbol, timeframe, feed, bar_start, open, high, low, close, volume, vwap, trade_count) VALUES ?", [rows.slice(i, i + 500)]);
	}
}

async function candles(symbol, { feed, from, to, timeframe = "1Min" }) {
	const [rows] = await pool.query(
		"SELECT bar_start, open, high, low, close, volume, vwap, trade_count FROM trading_candles WHERE symbol = ? AND timeframe = ? AND feed = ? AND bar_start >= ? AND bar_start < ? ORDER BY bar_start",
		[symbol, timeframe, feed, new Date(from), new Date(to)]);
	return rows.map((r) => ({ t: new Date(r.bar_start).getTime(), o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close), v: Number(r.volume), vw: num(r.vwap), n: r.trade_count }));
}

async function insertSnapshot(s) {
	const [res] = await pool.query(
		`INSERT INTO trading_market_snapshots (profile_id, session_date, kind, symbol, taken_at, data_source, feed, quote_at, last_bar_at, is_stale, market_phase, regime, assessment, payload_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[s.profile_id ?? null, s.session_date, s.kind, s.symbol ?? null, new Date(s.taken_at), s.data_source, s.feed, s.quote_at ? new Date(s.quote_at) : null, s.last_bar_at ? new Date(s.last_bar_at) : null,
			s.is_stale ? 1 : 0, s.market_phase, s.regime ?? null, s.assessment ?? null, JSON.stringify(s.payload)]);
	return res.insertId;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** The latest state of today's setup for a symbol, for evaluate()'s `previous`. */
async function signalState(profileId, date, symbol, versionId) {
	const [[s]] = await pool.query("SELECT * FROM trading_signals WHERE profile_id = ? AND session_date = ? AND symbol = ? AND strategy_version_id = ?", [profileId, date, symbol, versionId]);
	if (!s) return null;
	const [[e]] = await pool.query("SELECT reason FROM trading_signal_events WHERE signal_id = ? ORDER BY seq DESC LIMIT 1", [s.id]);
	return {
		id: s.id, uuid: s.uuid, symbol: s.symbol, session_date: dateOnly(s.session_date), status: s.status, state_key: s.state_key || s.status, reason: e?.reason || null,
		expires_at: iso(s.expires_at),
		confirmed: s.ever_confirmed ? { entry: num(s.confirmed_entry), stop: num(s.confirmed_stop), target: num(s.confirmed_target), at: iso(s.confirmed_at) } : null,
	};
}

/**
 * Record one evaluation. The first evaluation creates the signal; after that a
 * new event is appended only when the state changes, carrying the full
 * conditions, indicators and levels that produced it. The state is the status,
 * except that a paper setup (every condition but the feed) is its own state
 * (lifecycle.stateKey). Every evaluation, changed or not, moves
 * last_evaluated_at. Returns { signal_id, uuid, changed, from, from_key, seq }.
 */
async function recordEvaluation({ profileId, date, versionId, source, feed, result, snapshotId }) {
	const at = new Date(result.evaluated_at);
	const key = lifecycle.stateKey(result);
	let state = await signalState(profileId, date, result.symbol, versionId);
	if (!state) {
		const expires = lifecycle.expiryFor({ sessionDate: date, status: result.status, confirmedAt: result.confirmed?.at });
		await pool.query(
			`INSERT IGNORE INTO trading_signals (uuid, profile_id, session_date, symbol, strategy_version_id, data_source, feed, initial_status, initial_at, status, state_key, last_event_at, last_evaluated_at, expires_at, expiry_policy)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[uuidv4(), profileId, date, result.symbol, versionId, source, feed, result.status, at, result.status, key, at, at, expires, lifecycle.EXPIRY_POLICY]);
		state = await signalState(profileId, date, result.symbol, versionId);
		const inserted = await appendEvent(state.id, null, result, snapshotId);
		if (inserted && result.status === "ENTRY_CONFIRMED") await markConfirmed(state.id, result, date);
		return { signal_id: state.id, uuid: state.uuid, changed: inserted, from: null, seq: 1 };
	}
	await pool.query("UPDATE trading_signals SET last_evaluated_at = GREATEST(COALESCE(last_evaluated_at, ?), ?) WHERE id = ?", [at, at, state.id]);
	if (state.state_key === key) return { signal_id: state.id, uuid: state.uuid, changed: false, from: state.status };
	const seq = await appendEvent(state.id, state.status, result, snapshotId);
	if (!seq) return { signal_id: state.id, uuid: state.uuid, changed: false, from: state.status };
	await pool.query("UPDATE trading_signals SET status = ?, state_key = ?, last_event_at = ? WHERE id = ?", [result.status, key, at, state.id]);
	if (result.status === "ENTRY_CONFIRMED" && !state.confirmed) await markConfirmed(state.id, result, date);
	return { signal_id: state.id, uuid: state.uuid, changed: true, from: state.status, from_key: state.state_key, seq };
}

/** First confirmation: the plan's levels, and the entry window replaces the day's expiry. */
async function markConfirmed(signalId, result, date) {
	const c = result.confirmed;
	if (!c) return;
	const expires = lifecycle.expiryFor({ sessionDate: date, status: "ENTRY_CONFIRMED", confirmedAt: c.at });
	await pool.query("UPDATE trading_signals SET ever_confirmed = 1, confirmed_at = ?, confirmed_entry = ?, confirmed_stop = ?, confirmed_target = ?, expires_at = ? WHERE id = ? AND ever_confirmed = 0",
		[new Date(c.at), c.entry, c.stop, c.target, expires, signalId]);
}

/**
 * Expire this person's signals whose time is up: an EXPIRED event is appended
 * (the unique seq makes a concurrent second expiry a no-op) and the row turns
 * terminal. Returns the expired signals' ids.
 */
async function expireDue(profileId, now = Date.now()) {
	const [rows] = await pool.query(
		`SELECT * FROM trading_signals WHERE profile_id = ? AND status NOT IN ('EXIT_INVALIDATED','EXPIRED') AND expires_at IS NOT NULL AND expires_at <= ?`,
		[profileId, new Date(now)]);
	const expired = [];
	for (const s of rows) {
		const result = lifecycle.expiredResult(shapeSignal(s), now);
		const seq = await appendEvent(s.id, s.status, result, null);
		if (!seq) continue;
		await pool.query("UPDATE trading_signals SET status = 'EXPIRED', state_key = 'EXPIRED', last_event_at = ? WHERE id = ? AND status = ?", [new Date(now), s.id, s.status]);
		expired.push(s.id);
	}
	return expired;
}

/** Today's signals and every event of each, oldest first, for deriving notifications. */
async function signalsWithEventsForDay(profileId, date) {
	const [signals] = await pool.query(
		`SELECT s.*, v.version, v.status AS version_status FROM trading_signals s JOIN trading_strategy_versions v ON v.id = s.strategy_version_id
		 WHERE s.profile_id = ? AND s.session_date = ?`, [profileId, date]);
	if (!signals.length) return [];
	const [events] = await pool.query("SELECT * FROM trading_signal_events WHERE signal_id IN (?) ORDER BY signal_id, seq", [signals.map((s) => s.id)]);
	return signals.map((s) => ({
		...shapeSignal(s),
		events: events.filter((e) => Number(e.signal_id) === Number(s.id)).map((e) => ({
			seq: e.seq, evaluated_at: iso(e.evaluated_at), from_status: e.from_status, to_status: e.to_status, reason: e.reason,
			conditions: json(e.conditions_json), indicators: json(e.indicators_json), levels: json(e.levels_json), sizing: json(e.sizing_json),
		})),
	}));
}

/** One signal by uuid, with its strategy version's status. */
async function signalByUuid(profileId, uuid) {
	const [[s]] = await pool.query(
		`SELECT s.*, v.version, v.status AS version_status FROM trading_signals s JOIN trading_strategy_versions v ON v.id = s.strategy_version_id
		 WHERE s.profile_id = ? AND s.uuid = ?`, [profileId, uuid]);
	return s ? shapeSignal(s) : null;
}

/** Append with the next seq; a concurrent duplicate loses on the unique key and is dropped. */
async function appendEvent(signalId, fromStatus, result, snapshotId) {
	const [[{ next }]] = await pool.query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM trading_signal_events WHERE signal_id = ?", [signalId]);
	try {
		await pool.query(
			`INSERT INTO trading_signal_events (signal_id, seq, evaluated_at, last_bar_at, quote_at, from_status, to_status, reason, conditions_json, indicators_json, levels_json, sizing_json, snapshot_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[signalId, next, new Date(result.evaluated_at), result.data?.last_bar_at ? new Date(result.data.last_bar_at) : null, result.data?.quote_at ? new Date(result.data.quote_at) : null,
				fromStatus, result.status, String(result.reason).slice(0, 300), JSON.stringify(result.conditions), JSON.stringify({ ...result.indicators, data: result.data }),
				JSON.stringify(result.levels), result.sizing ? JSON.stringify(result.sizing) : null, snapshotId || null]);
		return next;
	} catch (err) {
		if (err.code === "ER_DUP_ENTRY") return 0;
		throw err;
	}
}

async function signalsForDay(profileId, date) {
	const [rows] = await pool.query(
		`SELECT s.*, v.version, v.status AS version_status FROM trading_signals s JOIN trading_strategy_versions v ON v.id = s.strategy_version_id
		 WHERE s.profile_id = ? AND s.session_date = ? ORDER BY s.symbol`, [profileId, date]);
	return rows.map(shapeSignal);
}

function shapeSignal(s) {
	return {
		id: s.id, uuid: s.uuid, session_date: dateOnly(s.session_date), symbol: s.symbol, strategy_version: s.version ?? null, version_status: s.version_status ?? null,
		data_source: s.data_source, feed: s.feed, initial_status: s.initial_status, initial_at: iso(s.initial_at), status: s.status, state_key: s.state_key || s.status, last_event_at: iso(s.last_event_at),
		last_evaluated_at: iso(s.last_evaluated_at), expires_at: iso(s.expires_at), expiry_policy: s.expiry_policy || null,
		ever_confirmed: !!s.ever_confirmed, confirmed_at: iso(s.confirmed_at), confirmed_entry: num(s.confirmed_entry), confirmed_stop: num(s.confirmed_stop), confirmed_target: num(s.confirmed_target),
		outcome: s.outcome, outcome_r: num(s.outcome_r), outcome_mfe_r: num(s.outcome_mfe_r), outcome_mae_r: num(s.outcome_mae_r),
	};
}

/** Signals over a date range, for history and setup analytics. */
async function signalsBetween(profileId, from, to) {
	const [rows] = await pool.query(
		`SELECT s.*, v.version, v.status AS version_status FROM trading_signals s JOIN trading_strategy_versions v ON v.id = s.strategy_version_id
		 WHERE s.profile_id = ? AND s.session_date BETWEEN ? AND ? ORDER BY s.session_date DESC, s.symbol`, [profileId, from, to]);
	return rows.map(shapeSignal);
}

/** Everything known about one signal, in order, for replay. */
async function signalWithEvents(profileId, uuid) {
	const [[s]] = await pool.query(
		`SELECT s.*, v.version, v.status AS version_status, v.params_json, v.params_hash FROM trading_signals s JOIN trading_strategy_versions v ON v.id = s.strategy_version_id
		 WHERE s.profile_id = ? AND s.uuid = ?`, [profileId, uuid]);
	if (!s) return null;
	const [events] = await pool.query("SELECT * FROM trading_signal_events WHERE signal_id = ? ORDER BY seq", [s.id]);
	return {
		...shapeSignal(s), params: json(s.params_json), params_hash: s.params_hash,
		events: events.map((e) => ({
			seq: e.seq, evaluated_at: iso(e.evaluated_at), last_bar_at: iso(e.last_bar_at), quote_at: iso(e.quote_at), from_status: e.from_status, to_status: e.to_status,
			reason: e.reason, conditions: json(e.conditions_json), indicators: json(e.indicators_json), levels: json(e.levels_json), sizing: json(e.sizing_json), snapshot_id: e.snapshot_id,
		})),
	};
}

async function setOutcome(signalId, o) {
	await pool.query("UPDATE trading_signals SET outcome = ?, outcome_r = ?, outcome_mfe_r = ?, outcome_mae_r = ?, outcome_measured_at = UTC_TIMESTAMP(3) WHERE id = ?",
		[o.outcome, o.r, o.mfe_r, o.mae_r, signalId]);
}

async function unmeasuredSignals(beforeDate) {
	const [rows] = await pool.query(
		`SELECT s.*, (SELECT e.evaluated_at FROM trading_signal_events e WHERE e.signal_id = s.id ORDER BY e.seq LIMIT 1) AS first_at
		 FROM trading_signals s WHERE s.outcome IS NULL AND s.session_date < ? ORDER BY s.session_date LIMIT 500`, [beforeDate]);
	return rows.map((r) => ({ ...shapeSignal(r), first_at: iso(r.first_at) }));
}

// ---------------------------------------------------------------------------
// Positions and journal
// ---------------------------------------------------------------------------

function shapePosition(r) {
	return {
		id: r.id, uuid: r.uuid, profile_id: r.profile_id, account_id: r.account_id, mode: r.mode, signal_id: r.signal_id, strategy_version_id: r.strategy_version_id, symbol: r.symbol, setup_type: r.setup_type,
		shares: num(r.shares), entry_price: num(r.entry_price), entry_at: iso(r.entry_at), planned_entry: num(r.planned_entry), planned_stop: num(r.planned_stop), planned_target: num(r.planned_target),
		entry_fees: num(r.entry_fees), exit_price: num(r.exit_price), exit_at: iso(r.exit_at), exit_fees: num(r.exit_fees), exit_reason: r.exit_reason, status: r.status,
		unsettled_funds_used: num(r.unsettled_funds_used), funds_settle_on: dateOnly(r.funds_settle_on),
		conditions_at_entry: json(r.conditions_at_entry_json), regime_at_entry: r.regime_at_entry,
		journal: r.j_id ? {
			realized_pl: num(r.realized_pl), fees: num(r.j_fees), planned_risk: num(r.planned_risk), realized_risk: num(r.realized_risk), r_multiple: num(r.r_multiple),
			entry_slippage: num(r.entry_slippage), followed_plan: r.followed_plan === null ? null : !!r.followed_plan, notes: r.notes, chart_snapshot: json(r.chart_snapshot_json),
		} : null,
	};
}

const POSITION_SELECT = `SELECT p.*, j.id AS j_id, j.realized_pl, j.fees AS j_fees, j.planned_risk, j.realized_risk, j.r_multiple, j.entry_slippage, j.followed_plan, j.notes, j.chart_snapshot_json
	FROM trading_positions p LEFT JOIN trading_journal j ON j.position_id = p.id`;

async function positions(profileId, { mode, status, from, to, limit = 500 } = {}) {
	const where = ["p.profile_id = ?"];
	const args = [profileId];
	if (mode) (where.push("p.mode = ?"), args.push(mode));
	if (status) (where.push("p.status = ?"), args.push(status));
	if (from) (where.push("p.entry_at >= ?"), args.push(new Date(from)));
	if (to) (where.push("p.entry_at < ?"), args.push(new Date(to)));
	const [rows] = await pool.query(`${POSITION_SELECT} WHERE ${where.join(" AND ")} ORDER BY p.entry_at DESC LIMIT ?`, [...args, limit]);
	return rows.map(shapePosition);
}

async function position(profileId, uuid) {
	const [rows] = await pool.query(`${POSITION_SELECT} WHERE p.profile_id = ? AND p.uuid = ?`, [profileId, uuid]);
	return rows[0] ? shapePosition(rows[0]) : null;
}

/** Opens a position row and, for live ones, the matching cash entries, in one transaction. */
async function openPosition(p, ledgerEntries = []) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const uuid = uuidv4();
		const [res] = await conn.query(
			`INSERT INTO trading_positions (uuid, profile_id, account_id, mode, signal_id, strategy_version_id, symbol, setup_type, shares, entry_price, entry_at, planned_entry, planned_stop, planned_target,
			 entry_fees, unsettled_funds_used, funds_settle_on, conditions_at_entry_json, regime_at_entry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[uuid, p.profile_id, p.account_id, p.mode, p.signal_id || null, p.strategy_version_id || null, p.symbol, p.setup_type || "orb_vwap", p.shares, p.entry_price, new Date(p.entry_at),
				p.planned_entry ?? null, p.planned_stop, p.planned_target ?? null, p.entry_fees || 0, p.unsettled_funds_used || 0, p.funds_settle_on || null,
				p.conditions_at_entry ? JSON.stringify(p.conditions_at_entry) : null, p.regime_at_entry || null]);
		await addLedger(p.account_id, ledgerEntries.map((e) => ({ ...e, position_id: res.insertId })), conn);
		await conn.commit();
		return uuid;
	} catch (err) {
		await conn.rollback();
		throw err;
	} finally {
		conn.release();
	}
}

/** Closes a position with its journal figures and (live) sale proceeds, in one transaction. */
async function closePosition(p, { exit_price, exit_at, exit_fees, exit_reason, journal }, ledgerEntries = []) {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		const [res] = await conn.query("UPDATE trading_positions SET exit_price = ?, exit_at = ?, exit_fees = ?, exit_reason = ?, status = 'closed' WHERE id = ? AND status = 'open'",
			[exit_price, new Date(exit_at), exit_fees || 0, exit_reason, p.id]);
		if (!res.affectedRows) {
			await conn.rollback();
			return false;
		}
		await conn.query(
			`INSERT INTO trading_journal (position_id, profile_id, realized_pl, fees, planned_risk, realized_risk, r_multiple, entry_slippage, followed_plan, notes, chart_snapshot_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[p.id, p.profile_id ?? journal.profile_id, journal.realized_pl, journal.fees, journal.planned_risk, journal.realized_risk, journal.r_multiple, journal.entry_slippage,
				journal.followed_plan === undefined || journal.followed_plan === null ? null : journal.followed_plan ? 1 : 0, journal.notes || null, journal.chart_snapshot ? JSON.stringify(journal.chart_snapshot) : null]);
		await addLedger(p.account_id, ledgerEntries.map((e) => ({ ...e, position_id: p.id })), conn);
		await conn.commit();
		return true;
	} catch (err) {
		await conn.rollback();
		throw err;
	} finally {
		conn.release();
	}
}

async function updateJournal(profileId, positionId, { followed_plan, notes }) {
	const sets = [];
	const args = [];
	if (followed_plan !== undefined) (sets.push("followed_plan = ?"), args.push(followed_plan === null ? null : followed_plan ? 1 : 0));
	if (notes !== undefined) (sets.push("notes = ?"), args.push(notes === null ? null : String(notes).slice(0, 4000)));
	if (!sets.length) return;
	await pool.query(`UPDATE trading_journal SET ${sets.join(", ")} WHERE position_id = ? AND profile_id = ?`, [...args, positionId, profileId]);
}

// ---------------------------------------------------------------------------
// Alerts and summaries
// ---------------------------------------------------------------------------

/** Inserts once per occurrence; returns true when this call created it. */
async function insertAlert(a) {
	const [res] = await pool.query(
		`INSERT IGNORE INTO trading_alerts (profile_id, kind, dedupe_key, signal_id, position_id, symbol, title, body, validated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[a.profile_id, a.kind, a.dedupe_key.slice(0, 160), a.signal_id || null, a.position_id || null, a.symbol || null, a.title.slice(0, 160), a.body.slice(0, 500), a.validated ? 1 : 0]);
	return res.affectedRows > 0;
}

async function alerts(profileId, { limit = 50 } = {}) {
	const [rows] = await pool.query("SELECT * FROM trading_alerts WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?", [profileId, limit]);
	return rows.map((r) => ({ id: r.id, kind: r.kind, symbol: r.symbol, title: r.title, body: r.body, validated: !!r.validated, delivery_state: r.delivery_state, created_at: iso(r.created_at), seen_at: iso(r.seen_at) }));
}

async function markAlertsSeen(profileId, ids) {
	if (!ids.length) return;
	await pool.query("UPDATE trading_alerts SET delivery_state = 'shown', seen_at = COALESCE(seen_at, UTC_TIMESTAMP(3)) WHERE profile_id = ? AND id IN (?) AND delivery_state = 'pending'", [profileId, ids]);
}

async function dismissAlert(profileId, id) {
	await pool.query("UPDATE trading_alerts SET delivery_state = 'dismissed', seen_at = COALESCE(seen_at, UTC_TIMESTAMP(3)) WHERE profile_id = ? AND id = ?", [profileId, id]);
}

async function saveDailySummary(profileId, date, mode, s) {
	await pool.query(
		`INSERT INTO trading_daily_summaries (profile_id, session_date, mode, trades, wins, losses, realized_pl, fees, r_total, plan_followed, plan_broken, signals_confirmed, signals_invalidated, regime, assessment)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE trades = VALUES(trades), wins = VALUES(wins), losses = VALUES(losses), realized_pl = VALUES(realized_pl), fees = VALUES(fees), r_total = VALUES(r_total),
		 plan_followed = VALUES(plan_followed), plan_broken = VALUES(plan_broken), signals_confirmed = VALUES(signals_confirmed), signals_invalidated = VALUES(signals_invalidated),
		 regime = COALESCE(VALUES(regime), regime), assessment = COALESCE(VALUES(assessment), assessment)`,
		[profileId, date, mode, s.trades, s.wins, s.losses, s.realized_pl, s.fees, s.r_total, s.plan_followed, s.plan_broken, s.signals_confirmed, s.signals_invalidated, s.regime || null, s.assessment || null]);
}

async function dailySummaries(profileId, from, to) {
	const [rows] = await pool.query("SELECT * FROM trading_daily_summaries WHERE profile_id = ? AND session_date BETWEEN ? AND ? ORDER BY session_date", [profileId, from, to]);
	return rows.map((r) => ({ ...r, session_date: dateOnly(r.session_date), realized_pl: num(r.realized_pl), fees: num(r.fees), r_total: num(r.r_total), updated_at: iso(r.updated_at) }));
}

async function backtestRuns(limit = 20) {
	const [rows] = await pool.query(
		`SELECT b.uuid, b.split, b.period_start, b.period_end, b.symbols_json, b.data_source, b.feed, b.metrics_json, b.status, b.started_at, b.finished_at, v.version, v.strategy_key
		 FROM trading_backtest_runs b JOIN trading_strategy_versions v ON v.id = b.strategy_version_id ORDER BY b.started_at DESC LIMIT ?`, [limit]);
	return rows.map((r) => ({ ...r, period_start: dateOnly(r.period_start), period_end: dateOnly(r.period_end), symbols: json(r.symbols_json), metrics: json(r.metrics_json), symbols_json: undefined, metrics_json: undefined, started_at: iso(r.started_at), finished_at: iso(r.finished_at) }));
}

async function saveBacktestRun(r) {
	await pool.query(
		`INSERT INTO trading_backtest_runs (uuid, strategy_version_id, split, period_start, period_end, symbols_json, data_source, feed, cost_model_json, metrics_json, trades_json, status, error, finished_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
		[uuidv4(), r.strategy_version_id, r.split, r.period_start, r.period_end, JSON.stringify(r.symbols), r.data_source, r.feed, JSON.stringify(r.cost_model), JSON.stringify(r.metrics || null),
			JSON.stringify(r.trades || null), r.status, r.error || null]);
}

module.exports = {
	DEFAULTS, hashParams, settlementDate,
	getAccount, ensureAccount, updateAccount, recordBrokerCheck, ledger, addLedger,
	ensureStrategyVersion, strategyVersions,
	saveWatchlist, addManualWatch, removeWatch, watchlist, lastScanAt, saveCandles, candles, insertSnapshot,
	signalState, recordEvaluation, expireDue, signalsWithEventsForDay, signalByUuid, signalsForDay, signalsBetween, signalWithEvents, setOutcome, unmeasuredSignals,
	positions, position, openPosition, closePosition, updateJournal,
	insertAlert, alerts, markAlertsSeen, dismissAlert, saveDailySummary, dailySummaries, backtestRuns, saveBacktestRun,
};
