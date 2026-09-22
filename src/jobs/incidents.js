#!/usr/bin/env node
/**
 * Nearby emergencies: read the county dispatch board, tell people about new
 * calls near their places.
 *
 *   node src/jobs/incidents.js              one tick: reads only if due
 *   node src/jobs/incidents.js --force      read now, whatever the rhythm
 *   node src/jobs/incidents.js --status     the rhythm and why, reading nothing
 *   node src/jobs/incidents.js --dry-run    compute the messages, write/send nothing
 *   node src/jobs/incidents.js --loop 300   a tick every 300s until stopped
 *
 * Scheduled every 5 minutes. The RHYTHM is decided in services/pulsepoint/
 * watch.js, not by cron: every 15 minutes when quiet, every 5 for an hour
 * once something comes up nearby, every few hours while PulsePoint is
 * blocking automated readers. A tick that is not due reads nothing. One
 * PulsePoint request per read, however many people are watching; safe to
 * overlap with itself (the nudge unique key means a racing pass writes
 * nothing twice).
 *
 * Exits 0 for a skipped tick and for a block — both are known states. Only
 * an unexpected failure exits 1.
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
	const health = await watch.sourcesHealth();
	for (const [label, h] of [["911 board", health.calls], ["weather", health.weather]]) {
		const due = watch.isDue(h);
		log(
			`${label}: every ${minutes(due.everyMs)} (${due.why}); ` +
				(due.due ? "due now" : `next in ${minutes(due.nextInMs)}`) +
				`; last ok ${h.lastOkAt ? new Date(h.lastOkAt).toISOString() : "never"}` +
				(h.blocked ? `; BLOCKED since ${new Date(h.blockedAt).toISOString()}` : "") +
				(h.lastError ? `; last error: ${h.lastError}` : "")
		);
	}
}

async function pass() {
	if (args.status) return status();
	const out = await watch.runOnce({ dryRun: args.dryRun, force: args.force });
	const { agency, active, results } = out;
	if (out.skipped) return log(`not due (every ${minutes(out.everyMs)}, ${out.why}); next in ${minutes(out.nextInMs)}`);
	const sources = [];
	if (out.blocked) sources.push(`${agency} BLOCKED (backing off; the weather service is unaffected)`);
	else if (out.read?.calls) sources.push(`${agency}: ${active} active county-wide`);
	else sources.push(`${agency}: not read this tick`);
	sources.push(out.read?.weather ? "weather: read" : "weather: not read this tick");
	const next = out.next
		? `next: 911 board in ${minutes(out.next.calls.everyMs)}, weather in ${minutes(out.next.weather.everyMs)}`
		: `next read in ${minutes(out.everyMs)}`;
	log(`${sources.join("; ")}; ${next} (${out.why})`);
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
