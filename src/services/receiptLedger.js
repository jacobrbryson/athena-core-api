/**
 * The receipts a person has filed from Mail, read back: Family → Finance.
 *
 * Read-only. email_receipt rows are written only when a file_receipt_email
 * action is approved (services/actions/registry.js); nothing here writes, and
 * every query is scoped to the caller's profile. Money is summed per currency
 * and never converted, and a receipt with no amount counts as a receipt but
 * adds nothing, rather than being guessed.
 */
const pool = require("../helpers/db");

const MAX_ROWS = 500;

/** "2026-10" for a DATE or DATETIME, in UTC (both are stored as UTC). */
function monthOf(value) {
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7);
}

const dayOf = (value) => {
	if (!value) return null;
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

async function list(profileId, { limit = MAX_ROWS } = {}) {
	const cap = Math.min(Math.max(Number(limit) || MAX_ROWS, 1), MAX_ROWS);
	const [rows] = await pool.query(
		`SELECT r.uuid, r.merchant, r.category, r.amount, r.currency, r.purchased_at, r.created_at,
		        t.subject, t.from_name, t.from_address
		   FROM email_receipt r
		   LEFT JOIN email_triage t ON t.id = r.email_triage_id AND t.profile_id = r.profile_id
		  WHERE r.profile_id = ?
		  ORDER BY COALESCE(r.purchased_at, DATE(r.created_at)) DESC, r.id DESC
		  LIMIT ?`,
		[profileId, cap]
	);

	const receipts = rows.map((r) => ({
		uuid: r.uuid,
		merchant: r.merchant || r.from_name || r.from_address || null,
		category: r.category || null,
		amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
		currency: r.currency || "USD",
		date: dayOf(r.purchased_at) || dayOf(r.created_at),
		// Whether `date` is when it was bought, or only when it was filed.
		dated: !!r.purchased_at,
		subject: r.subject || null,
	}));

	// Month by month, per currency, newest month first.
	const months = new Map();
	for (const r of receipts) {
		const month = monthOf(r.date);
		if (!month) continue;
		const m = months.get(month) || { month, count: 0, totals: new Map() };
		m.count++;
		if (r.amount !== null) m.totals.set(r.currency, Math.round(((m.totals.get(r.currency) || 0) + r.amount) * 100) / 100);
		months.set(month, m);
	}
	return {
		receipts,
		months: [...months.values()]
			.sort((a, b) => (a.month < b.month ? 1 : -1))
			.map((m) => ({ month: m.month, count: m.count, totals: [...m.totals].map(([currency, amount]) => ({ currency, amount })) })),
		truncated: receipts.length === cap,
	};
}

module.exports = { list };
