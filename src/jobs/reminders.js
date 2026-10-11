#!/usr/bin/env node
/**
 * Reminders that wait for a time: send the ones that are due, and ask about
 * conditional place reminders whose window closed ("you didn't make it to the
 * gym — still want it?").
 *
 *   node src/jobs/reminders.js              one tick
 *   node src/jobs/reminders.js --loop 60    a tick every 60s until stopped
 *
 * NOT on a schedule (owner, 2026-10-11: no every-minute poller). Each
 * reminder books one Cloud Task for its own time that runs this Cloud Run Job
 * (services/reminderWakeups), so it runs only when something is due. The
 * hourly athena-incidents run does the same pass as a backstop. Safe to
 * overlap with itself — every send is claimed in the database first.
 *
 * Place reminders that fire on arrival are NOT sent here; the phone reports
 * the arrival (services/placeReminders.arrived).
 *
 * Exits 0 when there was nothing to do. Only an unexpected failure exits 1.
 *
 * See services/timeReminders.js, services/placeReminders.js and
 * docs/capabilities/time-reminders.md.
 */
require("dotenv").config();
const pool = require("../helpers/db");
const timeReminders = require("../services/timeReminders");
const placeReminders = require("../services/placeReminders");

const args = { loop: 0 };
for (let i = 2; i < process.argv.length; i++) {
	if (process.argv[i] === "--loop") args.loop = Math.max(30, Number(process.argv[++i]) || 60);
}

const log = (...m) => console.log(`[reminders ${new Date().toISOString().slice(11, 19)}]`, ...m);

async function pass() {
	const now = new Date();
	const [times, expired] = await Promise.all([
		timeReminders.fireDue({ now }),
		placeReminders.expireDue({ now }),
	]);
	if (times.fired || times.retried || expired.asked) {
		log(`sent ${times.fired}, will retry ${times.retried}, asked about ${expired.asked} expired`);
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
	} while (args.loop);
	await pool.end().catch(() => undefined);
	process.exit(failed ? 1 : 0);
})();
