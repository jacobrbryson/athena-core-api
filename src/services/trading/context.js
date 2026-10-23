/**
 * Chat grounding for day-trading questions ("what are we watching?", "is this
 * a good entry?", "how many shares can we afford?", "how did we do this
 * week?"). Adults only. Built from the engine's own evaluation, with every
 * figure's timestamp and source, so the model explains real observations and
 * the rule engine's verdicts rather than inventing either.
 */

const engine = require("./engine");
const clock = require("./marketClock");

const KEYWORDS =
	/\b(day ?trad\w*|trading|watchlist|watching today|what are we watching|setups?|good entry|an entry|entry|vwap|breakout|opening range|stop loss|reward ?\/ ?risk|risk ?\/ ?reward|how many shares|can we afford|downside|skip trading|no trade|strategy|paper trad\w*|backtest\w*|signals?|fading|pulling back|scanner|premarket|pre-market|market open|spy|qqq)\b/i;

function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

const money = (x) => (x === null || x === undefined ? "—" : `$${Number(x).toFixed(2)}`);
const pct = (x) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);
const at = (iso) => (iso ? `${clock.etClock(iso)} ET` : "unknown time");

function withTimeout(promise, ms) {
	return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref?.())]);
}

function formatRow(w, i) {
	const s = w.signal;
	const lines = [`${i + 1}. ${w.symbol}${w.company_name ? ` (${w.company_name})` : ""} — last trade ${money(w.price)} at ${at(w.price_at)}, ${pct(w.change)} on the day. Signal: ${s?.status || "not evaluated"}${s?.reason ? ` — ${s.reason}` : ""}`];
	if (s?.next_step) lines.push(`   What must happen next: ${s.next_step}`);
	if (s?.conditions?.length) lines.push(`   Conditions: ${s.conditions.map((c) => `${c.label} ${c.state.toUpperCase()} (${c.detail})`).join("; ")}`);
	if (s?.indicators) lines.push(`   Indicators (closed candles, as of ${at(s.data?.last_bar_at)}): VWAP ${money(s.indicators.vwap)}, relative volume ${s.indicators.relative_volume ?? "—"}×, 1-min ATR ${money(s.indicators.atr_1m)}, spread ${money(s.indicators.spread)}.`);
	if (s?.levels?.or_high) lines.push(`   Levels: opening range ${money(s.levels.or_low)}–${money(s.levels.or_high)}${s.levels.stop ? `, structural stop ${money(s.levels.stop)}` : ""}${s.levels.target ? `, target ${money(s.levels.target)}` : ""}${s.levels.resistance ? `, resistance ${money(s.levels.resistance)}` : ""}.`);
	if (s?.sizing?.ok) lines.push(`   Sizing: ${s.sizing.shares} sh at ~${money(s.sizing.entry)} = ${money(s.sizing.position_cost)}; planned loss ${money(s.sizing.planned_loss)} (${money(s.sizing.est_loss_with_costs)} with costs, ${s.sizing.loss_pct_of_account}% of account); target gain ${money(s.sizing.est_gain_with_costs)} after costs.`);
	else if (s?.sizing?.reasons?.length) lines.push(`   Sizing: none — ${s.sizing.reasons.join(" ")}`);
	if (w.catalyst) lines.push(`   Catalyst: "${w.catalyst.headline}" (${w.catalyst.source || "news"}, ${at(w.catalyst.at)}).`);
	if (w.reasons?.length) lines.push(`   Scanner: ${w.reasons.join("; ")}.`);
	if (s?.data?.stale) lines.push(`   DATA PROBLEM: ${s.data.problems.join("; ")}.`);
	return lines.join("\n");
}

async function buildContext(profileId, { audience } = {}) {
	if (!profileId || audience !== "adult") return null;
	let p;
	try {
		p = await withTimeout(engine.evaluate(profileId), 8000);
	} catch (err) {
		return `Day-trading intelligence: unavailable right now (${err.message === "timeout" ? "market data didn't answer in time" : "the trading module couldn't read its data"}). Say so; don't guess prices, signals or levels.`;
	}
	const week = await engine.performance(profileId, { mode: "live", period: "week" }).catch(() => null);
	const paper = await engine.performance(profileId, { mode: "paper", period: "week" }).catch(() => null);
	const a = p.account;
	const lines = [
		"Day-trading intelligence (Family → Trading). A deterministic rules engine produced every status below; you explain it, you don't overrule it or invent signals.",
		"Rules for answering: label what is (1) a verified market fact (give its time), (2) the engine's signal, (3) your interpretation. Use only figures listed here — never invent a price, level, indicator or headline. Statuses are analytical signals, not predictions or instructions; the person decides and executes everything — you can't place, change or cancel orders. \"There isn't a trade worth taking right now\" is a good answer when true. Never add urgency or promise profit. You're not a licensed advisor: you explain what the person's own configured plan and rules show.",
		`Now: ${p.market.et_time} ET ${p.market.et_date}, market ${p.market.phase}${p.market.session.early_close ? " (early close 1:00 PM)" : ""}${p.market.session.calendar_verified ? "" : " (holiday table doesn't cover this date)"}.`,
		p.data.configured
			? `Data: ${p.data.source}, ${p.data.feed?.toUpperCase()} feed${p.data.feed === "iex" ? " (real-time but IEX-only, a few % of volume — ENTRY CONFIRMED is impossible on it)" : p.data.feed === "delayed_sip" ? " (15 minutes delayed — never confirms)" : " (full market, real-time)"}; stream ${p.data.stream.status}.`
			: "Data: market data is NOT connected (no Alpaca key yet), so there are no live prices or signals. Say so.",
		`Account (cash, Webull): settled cash ${money(a.cash.usable_settled)} usable${a.cash.unsettled ? `, ${money(a.cash.unsettled)} unsettled (not usable until it settles)` : ""}. Limits: ${money(a.settings.max_risk_per_trade)}/trade, ${money(a.settings.max_daily_loss)}/day, ${a.settings.max_trades_per_day} trades/day, ${a.settings.min_reward_risk}:1 minimum. Today: ${a.today.trades} trades, realized ${money(a.today.realized_pl)}, risk available ${money(a.today.risk_budget)}.`,
	];
	if (a.open_positions.length) lines.push(`Open positions (recorded by the person): ${a.open_positions.map((x) => `${x.symbol} ${x.shares} sh @ ${money(x.entry_price)}, stop ${money(x.planned_stop)}${x.planned_target ? `, target ${money(x.planned_target)}` : ""}`).join("; ")}.`);
	if (p.overview) {
		const o = p.overview;
		lines.push(`Market: regime ${o.regime}, assessment ${o.assessment} (${o.reasons.join(" ")}) SPY ${money(o.spy.price)} ${pct(o.spy.change)} (${o.spy.above_vwap === null ? "VWAP n/a" : o.spy.above_vwap ? "above VWAP" : "below VWAP"}), QQQ ${money(o.qqq.price)} ${pct(o.qqq.change)}, ${o.volatility.symbol} ${pct(o.volatility.change)}${o.breadth ? `, breadth ${o.breadth.above_vwap}/${o.breadth.of} ${o.breadth.basis}` : ""}. Leading sectors: ${o.sectors.slice(0, 3).map((s) => `${s.name} ${pct(s.change)}`).join(", ")}.`);
	}
	if (p.events.today.length) lines.push(`Scheduled events today: ${p.events.today.map((e) => `${e.name} ${at(e.at)}`).join(", ")}. (Calendar covers: ${p.events.coverage}.)`);
	else lines.push(`No scheduled high-impact events known today (calendar covers: ${p.events.coverage}).`);
	if (p.watchlist.length) lines.push(`Watchlist (strategy ${p.strategy?.key} v${p.strategy?.version}, ${p.strategy?.status === "validated" ? "validated" : "not yet validated by out-of-sample tests — say so if asked whether it works"}):`, ...p.watchlist.map(formatRow));
	else lines.push("Watchlist: empty. " + (p.note || "Nothing passed the scanner's filters."));
	if (p.no_trade_reason) lines.push(`No-trade note: ${p.no_trade_reason}`);
	if (week) lines.push(`This week, real trades: ${week.overall.trades} closed, net ${money(week.overall.net_pl)}, win rate ${week.overall.win_rate === null ? "—" : `${Math.round(week.overall.win_rate * 100)}%`}, avg R ${week.overall.avg_r ?? "—"}, rule compliance ${week.overall.rule_compliance === null ? "—" : `${Math.round(week.overall.rule_compliance * 100)}%`}.`);
	if (paper) lines.push(`This week, paper forward test: ${paper.overall.trades} closed, net ${money(paper.overall.net_pl)}, avg R ${paper.overall.avg_r ?? "—"}. Signals: ${paper.signals.confirmed} confirmed; of measured confirmations ${paper.signals.confirmed_target_first} hit target first, ${paper.signals.confirmed_stop_first} stop first. A handful of trades proves nothing either way.`);
	return lines.join("\n");
}

module.exports = { matches, buildContext };
