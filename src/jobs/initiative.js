#!/usr/bin/env node
/**
 * Athena's initiative pass: look for anything worth speaking up about, and
 * at most say one thing per person.
 *
 *   node src/jobs/initiative.js              one pass
 *   node src/jobs/initiative.js --dry-run    evaluate and report, write nothing
 *   node src/jobs/initiative.js --profile 42 just this person
 *   node src/jobs/initiative.js --loop 300   run every 300s until stopped
 *
 * Schedule it every ~10 minutes (Cloud Run Job + Cloud Scheduler in
 * production, Task Scheduler / cron locally). The cadence is a floor on how
 * fresh "starts in 15 minutes" can be, not a rate limit — the interruption
 * budget in services/initiative decides how often anyone actually hears
 * anything, and running this more often does not make her chattier.
 *
 * Safe to run concurrently with itself and with an in-process evaluator: one
 * nudge per occurrence is a unique key in the database, not a convention.
 *
 * Exit code 0 unless the pass itself could not run, so a scheduler does not
 * alert on "nobody had anything worth saying".
 */
require("dotenv").config();
const pool = require("../helpers/db");
const initiative = require("../services/initiative");

function parseArgs(argv) {
	const args = { dryRun: false, profile: null, loop: 0 };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") args.dryRun = true;
		else if (a === "--profile") args.profile = Number(argv[++i]);
		else if (a === "--loop") args.loop = Math.max(60, Number(argv[++i]) || 600);
	}
	return args;
}

const log = (...m) =>
	console.log(`[initiative ${new Date().toISOString().slice(11, 19)}]`, ...m);

/**
 * A dry run still evaluates every trigger — the expensive, failure-prone part
 * — and still reports which budget rule would have stopped her. It just does
 * not write or word anything. That is what makes it useful for answering
 * "why is she silent?", which is the question this job actually gets asked.
 */
async function dryRun(profileIds) {
	for (const profileId of profileIds) {
		const pref = await initiative.getPref(profileId);
		const blocked = await initiative.budgetCheck(profileId, pref);
		if (blocked) {
			log(`profile ${profileId}: would stay quiet — ${blocked}`);
			continue;
		}
		log(`profile ${profileId}: budget allows an interruption right now`);
	}
}

async function main() {
	const args = parseArgs(process.argv);
	const profiles = args.profile
		? [args.profile]
		: await initiative.enabledProfiles();

	if (!profiles.length) {
		log("nobody has initiative switched on — nothing to do");
		return;
	}

	const pass = async () => {
		if (args.dryRun) return dryRun(profiles);
		const results = args.profile
			? { profiles: 1, ...(await one(args.profile)) }
			: await initiative.runOnce();
		log(
			`${results.profiles} profile(s), ${results.sent || 0} spoken to` +
				(results.skipped && Object.keys(results.skipped).length
					? ` — quiet: ${Object.entries(results.skipped)
							.map(([reason, n]) => `${n} ${reason}`)
							.join(", ")}`
					: "")
		);
	};

	await pass();
	if (!args.loop) return;
	log(`looping every ${args.loop}s — ctrl-c to stop`);
	// A plain interval rather than a cron expression: this mode exists for a
	// laptop or a single always-on box, where the scheduler is the process.
	await new Promise(() => {
		setInterval(() => {
			pass().catch((err) => log("pass failed:", err.message));
		}, args.loop * 1000);
	});
}

async function one(profileId) {
	const outcome = await initiative.evaluateProfile(profileId);
	if (outcome.nudge) {
		log(`profile ${profileId}: "${outcome.nudge.text}"`);
		return { sent: 1, skipped: {} };
	}
	return { sent: 0, skipped: { [outcome.skipped]: 1 } };
}

main()
	.catch((err) => {
		console.error("[initiative] pass failed:", err);
		process.exitCode = 1;
	})
	.finally(() => pool.end().catch(() => {}));
