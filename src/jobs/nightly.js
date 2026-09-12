#!/usr/bin/env node
/**
 * Athena's nightly job: memory maintenance, then a self-review of her
 * performance and abilities that ends in an improvement plan.
 *
 *   node src/jobs/nightly.js                 full run
 *   node src/jobs/nightly.js --dry-run       no DB writes; report printed + saved locally
 *   node src/jobs/nightly.js --only review   skip maintenance
 *   node src/jobs/nightly.js --only maintenance
 *   node src/jobs/nightly.js --skip-evals    metrics + plan only (cheaper)
 *   node src/jobs/nightly.js --out <dir>     where to write the Markdown (default reports/self-review)
 *
 * Schedule it once per night (see docs/architecture/nightly-self-review.md):
 * Cloud Run Job + Cloud Scheduler in production, Task Scheduler / cron locally.
 * It runs local-first through the model router, so on a night with Orcwood
 * online the whole review uses idle local GPU, not frontier tokens.
 *
 * Exit code 0 even when individual steps fail (they're recorded in the
 * report); non-zero only if the report itself couldn't be produced.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("../helpers/db");
const llm = require("../services/llm");
const memoryStore = require("../services/memoryStore");
const { startOfLocalDay, DEFAULT_TZ } = require("../services/memoryStore/timeRange");
const { collectMetrics } = require("../services/selfReview/metrics");
const { runEvals } = require("../services/selfReview/evals");
const { ruleFindings, writePlan, fallbackPlan, renderMarkdown } = require("../services/selfReview/plan");

function parseArgs(argv) {
	const args = { dryRun: false, only: null, skipEvals: false, out: path.join(__dirname, "../../reports/self-review") };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") args.dryRun = true;
		else if (a === "--skip-evals") args.skipEvals = true;
		else if (a === "--only") args.only = argv[++i];
		else if (a === "--out") args.out = argv[++i];
	}
	return args;
}

const log = (...m) => console.log(`[nightly ${new Date().toISOString().slice(11, 19)}]`, ...m);

async function step(name, fn, results) {
	const started = Date.now();
	try {
		results[name] = { ok: true, ms: 0, ...(await fn()) };
	} catch (err) {
		results[name] = { ok: false, error: String(err?.message || err).slice(0, 300) };
		log(`step ${name} failed:`, err?.message || err);
	}
	results[name].ms = Date.now() - started;
	log(`step ${name}`, results[name].ok ? "ok" : "FAILED", `(${results[name].ms}ms)`);
}

async function maintenance({ dryRun }) {
	const results = {};
	if (dryRun) return { skipped: "dry run — no memory writes" };

	const audienceFor = Object.assign((id) => memoryStore.audienceForProfile(id), {
		memoryEnabled: (id) => memoryStore.memoryEnabledForProfile(id),
	});
	await step("extraction", () => memoryStore.extractPendingSessions({ audienceFor }), results);

	// Reflect on the previous local day.
	await step(
		"reflections",
		async () => {
			const today = startOfLocalDay(new Date(), DEFAULT_TZ);
			const from = new Date(today.getTime() - 86_400_000);
			const profiles = await memoryStore.profilesNeedingReflection(from, today);
			let written = 0;
			for (const profileId of profiles) {
				if (!(await memoryStore.memoryEnabledForProfile(profileId))) continue;
				const audience = await memoryStore.audienceForProfile(profileId);
				if (await memoryStore.reflectOnDay(profileId, { from, to: today, audience }).catch(() => null)) written += 1;
			}
			return { profiles: profiles.length, written };
		},
		results
	);
	await step("consolidation", () => memoryStore.consolidate(), results);
	// News BEFORE the backfill: ingest writes memories whose embeddings happen in
	// the background, so backfilling afterwards catches anything that failed the
	// same night instead of leaving it unsearchable until tomorrow.
	await step("news", () => memoryStore.ingestNews(), results);
	await step("embeddingBackfill", () => memoryStore.backfillEmbeddings({ limit: 1000 }), results);
	return results;
}

async function previousPlan() {
	try {
		const [rows] = await pool.query(
			`SELECT report_date, plan FROM self_review_report ORDER BY report_date DESC LIMIT 1;`
		);
		if (!rows.length) return null;
		const plan = typeof rows[0].plan === "string" ? JSON.parse(rows[0].plan) : rows[0].plan;
		return { date: rows[0].report_date, ...plan };
	} catch {
		return null;
	}
}

async function review({ dryRun, skipEvals, out }, maintenanceResults) {
	const date = new Date().toLocaleDateString("en-CA", { timeZone: DEFAULT_TZ }); // YYYY-MM-DD
	const status = llm.status();
	log("collecting metrics");
	const metrics = await collectMetrics({ embeddingSpace: status.embeddingSpace });

	let evals = { skipped: true, endpoints: {} };
	if (!skipEvals) {
		log("running capability evals");
		evals = await runEvals().catch((err) => ({ error: err.message, endpoints: {} }));
	}

	const findings = ruleFindings({ metrics, evals, config: { orcwoodCount: status.orcwood.length } });
	const prior = await previousPlan();

	log("writing plan");
	let plan;
	try {
		plan = await writePlan({ metrics, evals, findings, previousPlan: prior, date });
	} catch (err) {
		log("no model could write the plan — using rules only:", err.message);
		plan = fallbackPlan(findings);
	}

	const markdown = renderMarkdown({ date, metrics, evals, findings, plan, maintenance: maintenanceResults });

	fs.mkdirSync(out, { recursive: true });
	const file = path.join(out, `${date}${dryRun ? ".dry-run" : ""}.md`);
	fs.writeFileSync(file, markdown);
	fs.writeFileSync(file.replace(/\.md$/, ".json"), JSON.stringify({ date, metrics, evals, findings, plan }, null, 2));
	log(`report written: ${file}`);

	if (!dryRun) {
		await pool
			.query(
				`INSERT INTO self_review_report (report_date, metrics, evals, plan, markdown, served_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE metrics = VALUES(metrics), evals = VALUES(evals), plan = VALUES(plan),
           markdown = VALUES(markdown), served_by = VALUES(served_by), created_at = CURRENT_TIMESTAMP;`,
				[date, JSON.stringify(metrics), JSON.stringify(evals), JSON.stringify(plan), markdown, String(plan.servedBy || "").slice(0, 80)]
			)
			.then(() => log("report stored in self_review_report"))
			.catch((err) => log("could not store report in DB (file still written):", err.message));
	}
	return { file, markdown };
}

async function main() {
	const args = parseArgs(process.argv);
	log(`starting${args.dryRun ? " (dry run)" : ""}; policy=${llm.status().policy}`);
	await llm.startHealthLoop?.();

	let maintenanceResults = null;
	if (args.only !== "review") maintenanceResults = await maintenance(args);
	let result = null;
	if (args.only !== "maintenance") result = await review(args, maintenanceResults);

	if (result && args.dryRun) console.log(`\n${result.markdown}`);
	await pool.end().catch(() => undefined);
}

if (require.main === module) {
	main()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error("[nightly] fatal:", err);
			process.exit(1);
		});
}

module.exports = { main, parseArgs };
