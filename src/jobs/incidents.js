#!/usr/bin/env node
/**
 * Nearby emergencies: read the county dispatch board, tell people about new
 * calls near their places.
 *
 *   node src/jobs/incidents.js              one pass
 *   node src/jobs/incidents.js --dry-run    compute the messages, write/send nothing
 *   node src/jobs/incidents.js --loop 120   every 120s until stopped
 *
 * Schedule every 2 minutes (Cloud Run Job + Cloud Scheduler; see
 * deploy/scripts/setup-incident-watch.sh). One PulsePoint request per pass,
 * however many people are watching. Safe to overlap with itself: the nudge
 * unique key means a racing pass writes nothing twice.
 *
 * See services/pulsepoint/watch.js and docs/capabilities/nearby-incidents.md.
 */
require("dotenv").config();
const pool = require("../helpers/db");
const watch = require("../services/pulsepoint/watch");

const args = { dryRun: false, loop: 0 };
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a === "--dry-run") args.dryRun = true;
	else if (a === "--loop") args.loop = Math.max(60, Number(process.argv[++i]) || 120);
}

const log = (...m) => console.log(`[incidents ${new Date().toISOString().slice(11, 19)}]`, ...m);

async function pass() {
	const { agency, active, results } = await watch.runOnce({ dryRun: args.dryRun });
	log(`${agency}: ${active} active county-wide`);
	for (const r of results) {
		if (r.error) log(`profile ${r.profileId}: FAILED ${r.error}`);
		else if (!r.told && !r.cleared) log(`profile ${r.profileId}: ${r.nearby} nearby [${r.level}], nothing new`);
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
	} while (args.loop);
	await pool.end().catch(() => undefined);
	process.exit(failed ? 1 : 0);
})();
