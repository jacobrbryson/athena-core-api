/**
 * Position sizing and cost estimates. Pure; money is rounded to cents only at
 * the edges, and every rejection says why.
 *
 * The stop comes from price structure (strategy.js) BEFORE this runs. Sizing
 * never moves it: if the structural stop is too far for the budget, the answer
 * is fewer shares, and if that is zero, the answer is no trade.
 *
 *   risk per share  = entry − stop
 *   shares          = floor(min(settled cash / entry, risk budget / risk per share))
 *   planned loss    = shares × risk per share
 *   target          = entry + R × risk per share
 *
 * Costs are then layered on: slippage on both fills, half the spread on each
 * side, commission per order and the sell-side regulatory fees. Shares are cut
 * until the cost-inclusive loss also fits the budget. Stop orders can't
 * guarantee their price — a gap or a halt fills worse — which is why the
 * cost-inclusive figure is an estimate, not a cap.
 */

const cents = (x) => Math.round(x * 100) / 100;

function estimateFees(shares, exitPrice, costs) {
	const commission = 2 * (costs.commission_per_order || 0);
	const sec = shares * exitPrice * (costs.sec_fee_rate || 0);
	const taf = Math.min(8.3, shares * (costs.taf_fee_per_share || 0));
	return commission + sec + taf;
}

/**
 * @param {object} p
 * @param {number} p.entry          planned entry price (the ask when buying)
 * @param {number} p.stop           structural stop
 * @param {number} p.settledCash    cash that has settled and is free to use
 * @param {number} p.riskBudget     dollars this trade may lose (per-trade cap ∧ what's left of the day)
 * @param {number} p.rewardRisk     target multiple of R
 * @param {number} [p.spread]       current ask − bid
 * @param {boolean} [p.allowFractional]
 * @param {object} p.costs          the account's cost model
 * @param {number} [p.accountValue] for the percent-of-account figures
 * @param {number} [p.resistance]   nearest overhead level above entry, if any
 */
function sizePosition(p) {
	const reasons = [];
	const { entry, stop, settledCash, riskBudget, rewardRisk, costs } = p;
	if (!(entry > 0) || !(stop > 0)) return reject("Entry and stop must be positive prices.");
	const riskPerShare = entry - stop;
	if (!(riskPerShare > 0)) return reject("The stop is not below the entry.");
	if (!(riskBudget > 0)) return reject("No risk budget is left for today.");
	if (!(settledCash > 0)) return reject("There is no settled cash to trade with.");

	const slip = costs.slippage_per_share || 0;
	const halfSpread = (p.spread || 0) / 2;
	// What one share really costs to be wrong on: the stop distance plus
	// slippage and half the spread on the way in and on the way out.
	const costRiskPerShare = riskPerShare + 2 * (slip + halfSpread);
	const unit = p.allowFractional ? 1e-4 : 1;
	const floorTo = (x) => Math.floor(x / unit + 1e-9) * unit;

	const byCash = floorTo((settledCash - 2 * (costs.commission_per_order || 0)) / (entry + slip + halfSpread));
	const byRisk = floorTo(riskBudget / riskPerShare);
	let shares = Math.max(0, Math.min(byCash, byRisk));
	// Shrink until the cost-inclusive loss fits too.
	while (shares > 0 && shares * costRiskPerShare + estimateFees(shares, stop, costs) > riskBudget + 1e-9) shares = floorTo(shares - unit);
	if (shares <= 0) {
		if (byCash <= 0) reasons.push(`Settled cash of $${cents(settledCash)} doesn't cover one share at $${cents(entry)}.`);
		else reasons.push(`One share risks $${cents(costRiskPerShare)} with costs, over the $${cents(riskBudget)} budget. The stop is where the structure says; it isn't moved to fit.`);
		return { ok: false, shares: 0, reasons, risk_per_share: round4(riskPerShare) };
	}

	const target = entry + rewardRisk * riskPerShare;
	const fees = estimateFees(shares, target, costs);
	const plannedLoss = shares * riskPerShare;
	const estLoss = shares * costRiskPerShare + estimateFees(shares, stop, costs);
	const plannedGain = shares * (target - entry);
	const estGain = shares * (target - entry - 2 * (slip + halfSpread)) - fees;
	const toResistance = p.resistance && p.resistance > entry ? (p.resistance - entry) / riskPerShare : null;
	const value = p.accountValue || settledCash;
	return {
		ok: true,
		reasons,
		shares: round4(shares),
		limited_by: byRisk <= byCash ? "risk" : "cash",
		entry: round4(entry),
		stop: round4(stop),
		target: round4(target),
		risk_per_share: round4(riskPerShare),
		position_cost: cents(shares * entry),
		planned_loss: cents(plannedLoss),
		est_loss_with_costs: cents(estLoss),
		planned_gain: cents(plannedGain),
		est_gain_with_costs: cents(estGain),
		est_fees: cents(fees),
		reward_risk: round4(rewardRisk),
		room_to_resistance_r: toResistance === null ? null : round4(toResistance),
		loss_pct_of_account: value ? round4((estLoss / value) * 100) : null,
		gain_pct_of_account: value ? round4((estGain / value) * 100) : null,
	};

	function reject(reason) {
		return { ok: false, shares: 0, reasons: [reason], risk_per_share: null };
	}
}

function round4(x) {
	return Math.round(x * 1e4) / 1e4;
}

/**
 * Today's risk budget: the per-trade cap, but never more than what is left of
 * the daily loss limit once realized losses and the planned risk of positions
 * still open are counted.
 */
function riskBudget({ maxRiskPerTrade, maxDailyLoss, realizedLossToday, openPlannedRisk }) {
	const left = maxDailyLoss - Math.max(0, realizedLossToday) - Math.max(0, openPlannedRisk);
	return Math.max(0, Math.min(maxRiskPerTrade, left));
}

module.exports = { sizePosition, riskBudget, estimateFees };
