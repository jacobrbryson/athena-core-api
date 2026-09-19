#!/usr/bin/env node
/**
 * Athena's news round: visit every page whose interval has come up.
 *
 *   node src/jobs/news.js                 one pass over everything due
 *   node src/jobs/news.js --dry-run       fetch and extract, write nothing
 *   node src/jobs/news.js --source <uuid> just this page (ignores its schedule)
 *   node src/jobs/news.js --status        what she watches and when she'll be back
 *   node src/jobs/news.js --loop 300      every 300s until stopped
 *   node src/jobs/news.js --limit 40      cap how many pages one pass visits
 *
 * Schedule it every 5 minutes (Cloud Run Job + Cloud Scheduler in production,
 * Task Scheduler / cron locally). That cadence is a FLOOR on how fresh the
 * fastest source can be, not a rate: each source carries its own interval and
 * a pass only visits the ones that are due, so running this more often does
 * not make her read anything more often.
 *
 * Safe to run concurrently with itself, with the nightly job, and with someone
 * pressing "check now": due sources are leased before they are read (see
 * services/news/store.js), so two runners cannot fetch the same page.
 *
 * Exit code 0 unless the pass itself could not run, so a scheduler does not
 * alert on "one news site was down".
 */
require("dotenv").config();
const pool = require("../helpers/db");
const llm = require("../services/llm");
const news = require("../services/news");

function parseArgs(argv) {
	const args = { dryRun: false, source: null, loop: 0, limit: 30, status: false };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") args.dryRun = true;
		else if (a === "--status") args.status = true;
		else if (a === "--source") args.source = String(argv[++i] || "").trim();
		else if (a === "--loop") args.loop = Math.max(60, Number(argv[++i]) || 300);
		else if (a === "--limit") args.limit = Math.max(1, Math.min(200, Number(argv[++i]) || 30));
	}
	return args;
}

const log = (...m) => console.log(`[news ${new Date().toISOString().slice(11, 19)}]`, ...m);

const ago = (at) => {
	if (!at) return "never";
	const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
	return `${Math.round(minutes / 1440)}d ago`;
};

/**
 * The answer to "why is she checking that every fifteen minutes?", printed.
 * Deliberately the whole table including the house sources, because a
 * runaway interval is the failure mode worth being able to see at a glance.
 */
async function status() {
	const sources = await news.listAll();
	if (!sources.length) return log("nothing is being watched yet");
	for (const source of sources) {
		const owner = source.profileId ? `profile ${source.profileId}` : "house";
		const borrowed = source.intervalExpiresAt ? ` until ${new Date(source.intervalExpiresAt).toISOString().slice(0, 16)}` : "";
		log(
			`${source.host} [${owner}, ${source.scope}]${source.enabled ? "" : " (paused)"} — ` +
				`${news.rhythm(source.intervalMinutes)}${borrowed}, set by ${source.intervalSetBy}, ` +
				`last read ${ago(source.lastCheckedAt)}, last new ${ago(source.lastChangedAt)}` +
				(source.intervalReason ? `\n    "${source.intervalReason}"` : "") +
				(source.lastError ? `\n    last error: ${source.lastError}` : "")
		);
	}
}

async function onePass(args) {
	if (args.source) {
		const result = await news.pollByUuid(args.source, { dryRun: args.dryRun });
		if (!result) {
			log(`no source with uuid ${args.source}`);
			return { checked: 0, changed: 0, failed: 0 };
		}
		log(
			`${result.host}: ${result.status}, ${result.found} headlines, ${result.added} new -> ` +
				`${news.rhythm(result.intervalAfter || 0)} (${result.decidedBy || "unchanged"})${result.note ? ` — ${result.note}` : ""}`
		);
		return { checked: 1, changed: result.added > 0 ? 1 : 0, failed: result.status === "error" ? 1 : 0 };
	}

	const pass = await news.pollDue({ limit: args.limit, dryRun: args.dryRun });
	for (const result of pass.results) {
		log(
			`${result.host}: ${result.status}, ${result.added}/${result.found} new -> ` +
				`${news.rhythm(result.intervalAfter || 0)} (${result.decidedBy || "held"})${result.note ? ` — ${result.note}` : ""}`
		);
	}
	log(`pass done: ${pass.checked} visited, ${pass.changed} with something new, ${pass.failed} failed`);
	return pass;
}

async function main() {
	const args = parseArgs(process.argv);
	log(`starting${args.dryRun ? " (dry run)" : ""}; policy=${llm.status().policy}`);
	await llm.startHealthLoop?.();
	// The env-declared house sources are seeded here rather than at server
	// start: this is the process that reads them, and it is idempotent.
	if (!args.dryRun && !args.source) {
		const seeded = await news.seedHouseSources().catch((err) => ({ added: 0, error: err.message }));
		if (seeded.added) log(`seeded ${seeded.added} source(s) from NEWS_FEEDS`);
	}

	if (args.status) {
		await status();
		return;
	}

	if (!args.loop) {
		await onePass(args);
		return;
	}
	log(`looping every ${args.loop}s — ctrl-c to stop`);
	for (;;) {
		await onePass(args).catch((err) => log("pass failed:", err.message));
		await new Promise((resolve) => setTimeout(resolve, args.loop * 1000));
	}
}

if (require.main === module) {
	main()
		.then(async () => {
			await pool.end().catch(() => undefined);
			process.exit(0);
		})
		.catch(async (err) => {
			console.error("[news] fatal:", err);
			await pool.end().catch(() => undefined);
			process.exit(1);
		});
}

module.exports = { main, parseArgs };
