/**
 * Cash-account arithmetic over trading_cash_ledger rows. Pure.
 *
 * The one rule that keeps this conservative: money going OUT counts the moment
 * it is committed, money coming IN counts only once it has settled. So sale
 * proceeds are not "available" until T+1, unrealized gains are never cash, and
 * a deposit is available on the date it was recorded as settling.
 */

const { settlementDate } = require("./marketClock");

const num = (x) => Number(x) || 0;
const cents = (x) => Math.round(x * 100) / 100;

/** { settled, unsettled, total, pending: [{ settles_on, amount }] } as of ET date `today`. */
function balances(entries, today) {
	let settled = 0;
	let unsettled = 0;
	const pending = new Map();
	for (const e of entries) {
		const amount = num(e.amount);
		const settles = String(e.settles_on).slice(0, 10);
		if (amount < 0 || settles <= today) settled += amount;
		else {
			unsettled += amount;
			pending.set(settles, (pending.get(settles) || 0) + amount);
		}
	}
	return {
		settled: cents(settled),
		unsettled: cents(unsettled),
		total: cents(settled + unsettled),
		pending: [...pending].sort(([a], [b]) => a.localeCompare(b)).map(([settles_on, amount]) => ({ settles_on, amount: cents(amount) })),
	};
}

/**
 * How a purchase of `cost` on `today` is funded: settled cash first, then
 * unsettled proceeds. Returns the unsettled part and the date by which it will
 * have settled — selling the new position before then is a good-faith
 * violation in a cash account.
 */
function fundPurchase(entries, today, cost) {
	const b = balances(entries, today);
	const fromSettled = Math.max(0, Math.min(cost, b.settled));
	let need = cost - fromSettled;
	let settleOn = null;
	for (const p of b.pending) {
		if (need <= 0) break;
		need -= p.amount;
		settleOn = p.settles_on;
	}
	return {
		unsettled_used: cents(cost - fromSettled),
		funds_settle_on: cost - fromSettled > 0 ? settleOn : null,
		short_by: need > 0.005 ? cents(need) : 0,
	};
}

/** Would selling this position today be a good-faith violation? */
function goodFaithViolation(position, saleDate) {
	return num(position.unsettled_funds_used) > 0 && position.funds_settle_on && saleDate < String(position.funds_settle_on).slice(0, 10);
}

/** Ledger rows for a buy and for a sell. */
function buyEntries({ shares, price, fees, tradeDate, positionId }) {
	return [{ kind: "buy", amount: -cents(shares * price + num(fees)), trade_date: tradeDate, settles_on: settlementDate(tradeDate), position_id: positionId }];
}
function sellEntries({ shares, price, fees, tradeDate, positionId }) {
	return [{ kind: "sell", amount: cents(shares * price - num(fees)), trade_date: tradeDate, settles_on: settlementDate(tradeDate), position_id: positionId }];
}

module.exports = { balances, fundPurchase, goodFaithViolation, buyEntries, sellEntries };
