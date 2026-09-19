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
 * fresh "starts in 15 minutes" can be.
 *
 * Since the interruption budget was removed, this cadence IS most of what
 * decides how often she speaks — there is no longer a spacing rule behind it
 * absorbing a fast schedule. Dedupe still guarantees one nudge per
 * occurrence however often this runs, so running it more often makes her
 * more timely rather than more repetitive, but it does mean a trigger with a
 * loose condition now shows up every pass instead of once every ninety
 * minutes. That is a threshold to fix in the trigger, not here.
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
 * A dry run reports every gate between an observation and a sentence, without
 * writing or wording anything. `diagnose` is the same call the in-app panel
 * makes, so the job and the UI cannot drift into disagreeing about why she is
 * silent — which is the question this job actually gets asked.
 */
async function dryRun(profileIds) {
	for (const profileId of profileIds) {
		const report = await initiative.diagnose(profileId, { evaluate: true });
		if (report.budget.blocked_by) {
			log(`profile ${profileId}: would stay quiet — ${report.budget.blocked_by}`);
			continue;
		}
		const firing = report.triggers.filter((t) => t.would_fire);
		const held = report.budget.in_quiet_hours ? " (quiet hours — would be held, not dropped)" : "";
		if (!firing.length) {
			const blocked = report.triggers.filter((t) => t.blocked_by);
			log(
				`profile ${profileId}: nothing to say` +
					(blocked.length
						? ` — ${blocked.map((t) => `${t.id}: ${t.blocked_by}`).join("; ")}`
						: "")
			);
			continue;
		}
		log(`profile ${profileId}: would say ${firing.length} thing(s)${held}`);
		for (const t of firing) log(`    ${t.id}: ${t.brief}`);
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
			`${results.profiles} profile(s), ${results.sent || 0} nudge(s) written` +
				(results.released ? `, ${results.released} held one(s) released` : "") +
				(results.held ? `, ${results.held} held for quiet hours` : "") +
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
	// Anything written overnight goes out first, same as a full pass.
	const pref = await initiative.getPref(profileId);
	const { released } = await initiative
		.releaseHeld(profileId, pref)
		.catch(() => ({ released: 0 }));

	const outcome = await initiative.evaluateProfile(profileId);
	if (outcome.nudges?.length) {
		for (const nudge of outcome.nudges) log(`profile ${profileId}: "${nudge.text}"`);
		if (outcome.held) log(`profile ${profileId}: held for quiet hours, will go out at the window's end`);
		return { sent: outcome.nudges.length, released, skipped: {} };
	}
	return { sent: 0, released, skipped: { [outcome.skipped]: 1 } };
}

main()
	.catch((err) => {
		console.error("[initiative] pass failed:", err);
		process.exitCode = 1;
	})
	.finally(() => pool.end().catch(() => {}));
