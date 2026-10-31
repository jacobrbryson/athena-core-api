#!/usr/bin/env node
/**
 * Nearby emergencies: read the weather service for everyone's watched places,
 * tell people about new alerts, and retire phone-reported 911 calls whose
 * clock has run out.
 *
 *   node src/jobs/incidents.js              one tick: reads only if due
 *   node src/jobs/incidents.js --force      read now, whatever the rhythm
 *   node src/jobs/incidents.js --status     the rhythm and why, reading nothing
 *   node src/jobs/incidents.js --dry-run    compute the messages, write/send nothing
 *   node src/jobs/incidents.js --loop 300   a tick every 300s until stopped
 *
 * Scheduled every 5 minutes. The RHYTHM is decided in services/pulsepoint/
 * watch.js, not by cron: every 15 minutes when quiet, every 5 for an hour
 * once something comes up nearby. A tick that is not due reads nothing.
 *
 * 911 calls are NOT polled here. PulsePoint blocks automated readers, and the
 * owner removed the web-board poller on 2026-09-26: calls arrive from the
 * PulsePoint app's own notifications on the phone (POST
 * /dashboard/incidents/phone-alert).
 *
 * Exits 0 for a skipped tick. Only an unexpected failure exits 1.
 *
 * See services/pulsepoint/watch.js and docs/capabilities/nearby-incidents.md.
 */
require("dotenv").config();
const pool = require("../helpers/db");
const watch = require("../services/pulsepoint/watch");
const timeReminders = require("../services/timeReminders");
const placeReminders = require("../services/placeReminders");
const weatherAlerts = require("../services/weatherAlerts");

const args = { dryRun: false, loop: 0, force: false, status: false };
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a === "--dry-run") args.dryRun = true;
	else if (a === "--force") args.force = true;
	else if (a === "--status") args.status = true;
	else if (a === "--loop") args.loop = Math.max(60, Number(process.argv[++i]) || 120);
}

const log = (...m) => console.log(`[incidents ${new Date().toISOString().slice(11, 19)}]`, ...m);

const minutes = (ms) => `${Math.round((ms || 0) / 60000)} min`;

async function status() {
	const { weather: h } = await watch.sourcesHealth();
	const due = watch.isDue(h);
	log(
		`weather: every ${minutes(due.everyMs)} (${due.why}); ` +
			(due.due ? "due now" : `next in ${minutes(due.nextInMs)}`) +
			`; last ok ${h.lastOkAt ? new Date(h.lastOkAt).toISOString() : "never"}` +
			(h.lastError ? `; last error: ${h.lastError}` : "")
	);
}

/**
 * The reminders backstop. Reminders wake their own job at their own time
 * (services/reminderWakeups); this hourly run sends anything that wake-up
 * missed, so a lost task makes a reminder late rather than lost. Never fails
 * the incidents pass.
 */
async function reminderBackstop() {
	if (args.dryRun || args.status) return;
	try {
		const now = new Date();
		const [times, expired] = await Promise.all([timeReminders.fireDue({ now }), placeReminders.expireDue({ now })]);
		if (times.fired || times.retried || expired.asked) {
			log(`reminders backstop: sent ${times.fired}, retrying ${times.retried}, asked about ${expired.asked} expired`);
		}
	} catch (error) {
		log("reminders backstop failed:", error.message);
	}
}

/**
 * The person's own weather alerts ("34°F or colder at Home"). Each rule
 * re-reads the forecast every half hour whatever this job's rhythm is; a rule
 * not due costs one indexed SELECT. Never fails the incidents pass.
 */
async function weatherAlertPass() {
	if (args.status) return;
	try {
		const out = await weatherAlerts.checkDue({ dryRun: args.dryRun });
		if (out.sent || out.held || out.failed || (args.dryRun && out.messages.length)) {
			log(`weather alerts: checked ${out.checked}, sent ${out.sent}, held for morning ${out.held}, failed ${out.failed}`);
			if (args.dryRun) for (const m of out.messages) log(`  profile ${m.profileId}: ${m.text}`);
		}
	} catch (error) {
		log("weather alerts failed:", error.message);
	}
}

/**
 * The Guardian Engine's planner (services/guardianEngine): books tonight's
 * sweep, starts a storm umbrella watch when the weather turns, books
 * rechecks, escalates, retries notifications and reports missed runs. This
 * job can't reach the cameras, so anything due to be looked at is handed to
 * the core service (POST /internal/guardian/dispatch). Never fails the pass.
 */
async function guardianPass() {
	if (args.status || args.dryRun) return;
	try {
		const guardian = require("../services/guardianEngine");
		const planned = await guardian.plan();
		if (planned.scheduled.length || planned.storm?.created) log(`guardian: scheduled ${planned.scheduled.length}${planned.storm?.created ? ", storm watch started" : ""}`);
		if (planned.due) {
			const sent = await require("../services/guardianEngine/dispatch").dispatchNow({ reason: "incidents job" });
			log(`guardian: ${planned.due} due — dispatch ${sent.ok ? `ran ${sent.body?.ran ?? "?"}` : `not delivered (${sent.skipped || sent.status || sent.error})`}`);
		}
	} catch (error) {
		log("guardian failed:", error.message);
	}
}

/**
 * The outage watch's backstop (services/outage). When the home internet is
 * out nothing can say so, so detection is by absence and the first signal
 * books a delayed check; this is the net under it. DB only here: if no
 * assessment ran in the last hour (every 15 minutes while an outage is open),
 * ask the core service to run one — it alone reaches the camera bridge. This
 * is the existing job's rhythm, not a new poller. Never fails the pass.
 */
async function outagePass() {
	if (args.status || args.dryRun) return;
	try {
		const reason = await require("../services/outage").backstopDue();
		if (!reason) return;
		const sent = await require("../services/guardianEngine/dispatch").dispatchNow({ reason });
		log(`outage watch: ${sent.ok ? `ran (${sent.body?.outage?.verdict || sent.body?.outage?.error || "?"})` : `not delivered (${sent.skipped || sent.status || sent.error})`}`);
	} catch (error) {
		log("outage watch failed:", error.message);
	}
}

/**
 * The trading monitor's backstop (services/trading/monitor.js). During market
 * hours, with someone's trading notifications on, ask the core service for a
 * tick; it ignores the ask while its own Cloud Tasks chain is alive, so this
 * only restarts a chain that broke or never started. Never fails the pass.
 */
async function tradingPass() {
	if (args.status || args.dryRun) return;
	try {
		const out = await require("../services/trading/monitor").backstop();
		if (!out.skipped) log(`trading monitor: ${out.ok ? (out.body?.skipped ? `chain alive` : `ticked for ${out.body?.profiles ?? "?"}`) : `not delivered (${out.status || out.error})`}`);
	} catch (error) {
		log("trading monitor failed:", error.message);
	}
}

/**
 * The backstop for Guardians mission deadlines: a step's own Cloud Task does
 * the work, and this catches one that was never booked or was held. Asks the
 * core service, which alone reaches the devices. Never fails the pass.
 */
async function missionPass() {
	if (args.status || args.dryRun) return;
	try {
		const url = (process.env.GUARDIAN_DISPATCH_URL || "").replace("/internal/guardian/dispatch", "/internal/guardian-missions/tick");
		const out = await require("../services/guardianEngine/dispatch").dispatchNow({ reason: "backstop", url });
		if (!out.ok && !out.skipped) log(`mission deadlines: not delivered (${out.status || out.error})`);
	} catch (error) {
		log("mission deadlines failed:", error.message);
	}
}

async function pass() {
	if (args.status) return status();
	await reminderBackstop();
	await weatherAlertPass();
	await guardianPass();
	await outagePass();
	await tradingPass();
	await missionPass();
	if (!args.dryRun) {
		try { await require('../services/workItems/engine').sweep(); }
		catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') log('Work notifications unavailable:', err.message); }
	}
	const out = await watch.runOnce({ dryRun: args.dryRun, force: args.force });
	const { results } = out;
	if (out.skipped) return log(`not due (every ${minutes(out.everyMs)}, ${out.why}); next in ${minutes(out.nextInMs)}`);
	log(`weather: read; next read in ${minutes(out.everyMs)} (${out.why})`);
	for (const r of results) {
		if (r.error) log(`profile ${r.profileId}: FAILED ${r.error}`);
		else if (!r.told && !r.cleared)
			log(`profile ${r.profileId}: ${r.nearby} nearby, ${r.weather} weather [${r.level}], nothing new`);
		else
			log(
				`profile ${r.profileId}: [${r.level}] told ${r.told}${r.cleared ? " (all clear)" : ""}` +
					(r.pushed ? ` — pushed ${JSON.stringify(r.pushed.sent ?? 0)}${r.pushed.skipped ? ` (${r.pushed.skipped})` : ""}` : "") +
					`\n${r.text}`
			);
	}
}

(async () => {
	let failed = false;
	do {
		try {
			await pass();
		} catch (error) {
			failed = true;
			log("pass failed:", error.message);
		}
		if (args.loop) await new Promise((r) => setTimeout(r, args.loop * 1000));
	} while (args.loop && !args.status);
	await pool.end().catch(() => undefined);
	process.exit(failed ? 1 : 0);
})();
