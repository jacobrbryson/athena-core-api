/**
 * Server-side monitoring during market hours — so a setup is noticed while
 * nobody has the Trading page open.
 *
 * There is no every-minute scheduler (docs: no frequent schedules). Instead a
 * chain of Cloud Tasks runs only on trading days, only from 15 minutes before
 * the open to 10 minutes after the close, and only while someone has trading
 * notifications switched on: each tick evaluates, notifies, and books the
 * next one. The athena-incidents job (every 5 minutes) is the backstop: in
 * the window it asks for a tick, and the service ignores that ask when its
 * chain ticked recently. Outside the window nothing is booked, so the
 * service still scales to zero overnight and at weekends.
 *
 * Ticks reach POST /internal/trading/tick with the same Google-signed ID
 * token and allowlisted service account as the Guardian dispatch
 * (guardianEngine/dispatch.js). Env:
 *   TRADING_TICK_URL                optional; default <GUARDIAN_DISPATCH_AUDIENCE>/internal/trading/tick
 *   TRADING_MONITOR_INTERVAL_S      seconds between ticks (default 60, minimum 30)
 *
 * A tick only evaluates and notifies. Nothing here can place an order.
 */

const dispatch = require("../guardianEngine/dispatch");
const clock = require("./marketClock");

const MINUTE = 60_000;
const BEFORE_OPEN_MIN = 15;
const AFTER_CLOSE_MIN = 10;

let lastTickAt = 0;
let running = null;

const intervalMs = () => Math.max(30, Number(process.env.TRADING_MONITOR_INTERVAL_S) || 60) * 1000;

function tickUrl() {
	if (process.env.TRADING_TICK_URL) return process.env.TRADING_TICK_URL;
	const base = process.env.GUARDIAN_DISPATCH_AUDIENCE;
	return base ? `${base.replace(/\/$/, "")}/internal/trading/tick` : null;
}

const configured = () => dispatch.configured() && Boolean(tickUrl());

/** Inside today's monitoring window? */
function inWindow(at = Date.now()) {
	const session = clock.sessionFor(clock.etParts(new Date(at)).date);
	if (!session.trading) return false;
	return at >= Date.parse(session.open_at) - BEFORE_OPEN_MIN * MINUTE && at <= Date.parse(session.close_at) + AFTER_CLOSE_MIN * MINUTE;
}

/**
 * One pass for everyone with notifications on. Single-flight per instance.
 * `reason: 'backstop'` is skipped while the chain is alive.
 */
async function tick({ now = Date.now(), reason = "tick", book = true } = {}) {
	if (reason === "backstop" && now - lastTickAt < 2.5 * intervalMs()) return { skipped: "chain alive", last_tick_at: new Date(lastTickAt).toISOString() };
	if (running) return running;
	running = (async () => {
		lastTickAt = now;
		const engine = require("./engine");
		const notifications = require("./notifications");
		const ph = clock.phase(now);
		const profiles = await notifications.enabledProfiles();
		const results = [];
		for (const profileId of profiles) {
			let dashboard = null;
			if (ph.phase === "premarket" || ph.phase === "open") {
				dashboard = await engine.evaluate(profileId).catch((err) => {
					console.warn("[trading] monitor evaluation failed", { profileId, code: err?.code || null, message: err?.message });
					return null;
				});
			}
			// A tick during a market-data outage still expires and delivers
			// what it can; actionable rows lapse on re-validation.
			results.push({ profile_id: profileId, ...(await notifications.process(profileId, { now, dashboard: ph.phase === "open" ? dashboard : null })) });
		}
		const next = now + intervalMs();
		const booked = book && profiles.length && inWindow(next) ? await dispatch.wakeAt(next, { url: tickUrl(), name: "trading-tick", reason: "tick" }) : false;
		return { phase: ph.phase, profiles: profiles.length, results, next_booked: booked };
	})().finally(() => {
		running = null;
	});
	return running;
}

/** The incidents job's call: start (or restart) the chain if it should be running. */
async function backstop({ now = Date.now() } = {}) {
	if (!configured() || !inWindow(now)) return { skipped: !configured() ? "not configured" : "outside the market window" };
	const notifications = require("./notifications");
	if (!(await notifications.enabledProfiles()).length) return { skipped: "nobody has trading notifications on" };
	return dispatch.dispatchNow({ url: tickUrl(), reason: "backstop" });
}

/** For the Notifications section: is monitoring server-side, and how often. */
function info() {
	return {
		configured: configured(),
		interval_s: intervalMs() / 1000,
		window: `${BEFORE_OPEN_MIN} min before the open to ${AFTER_CLOSE_MIN} min after the close, trading days only`,
		last_tick_at: lastTickAt ? new Date(lastTickAt).toISOString() : null,
		note: configured() ? null : "Server-side monitoring isn't configured on this server, so setups are evaluated only while the Trading page is open.",
	};
}

module.exports = { tick, backstop, inWindow, info, tickUrl, configured, _reset: () => { lastTickAt = 0; running = null; } };
