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

async function pass() {
	if (args.status) return status();
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
