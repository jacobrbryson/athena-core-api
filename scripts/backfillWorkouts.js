#!/usr/bin/env node
/**
 * Backfill athena_workout from WHOOP's full workout history for ONE profile.
 *
 *   node scripts/backfillWorkouts.js <profileId>             # record everything
 *   node scripts/backfillWorkouts.js <profileId> --dry-run   # read + summarise only
 *   node scripts/backfillWorkouts.js <profileId> --since 2025-01-01
 *
 * Pages /v2/activity/workout 25 at a time (WHOOP's ceiling) and upserts each
 * page, so a rerun is harmless. Recording is gated exactly as everywhere else
 * (adult + health_data consent) — workoutHistory.record() writes nothing
 * otherwise, and this says so. Prints a per-sport summary, never tokens.
 */
require("dotenv").config();
const pool = require("../src/helpers/db");
const whoop = require("../src/services/connectors/whoop");
const workoutHistory = require("../src/services/workoutHistory");

async function main() {
	const args = process.argv.slice(2);
	const profileId = Number(args[0]);
	if (!Number.isSafeInteger(profileId) || profileId <= 0) throw new Error("Usage: backfillWorkouts.js <profileId> [--dry-run] [--since YYYY-MM-DD]");
	const dryRun = args.includes("--dry-run");
	const sinceAt = args.indexOf("--since");
	const start = new Date(sinceAt >= 0 ? args[sinceAt + 1] : "2012-01-01").toISOString();
	if (!dryRun && !(await workoutHistory.mayRecord(profileId))) {
		throw new Error(`Profile ${profileId} may not record workouts (needs an adult profile and health_data consent).`);
	}

	const bySport = new Map();
	let pages = 0, read = 0, written = 0, nextToken = null, oldest = null;
	do {
		const page = await whoop.workoutPage(profileId, { start, end: new Date().toISOString(), nextToken });
		if (page.nextToken && page.nextToken === nextToken) throw new Error("WHOOP pagination stalled");
		nextToken = page.nextToken;
		pages++; read += page.records.length;
		for (const w of page.records) {
			const s = bySport.get(w.sport) || { count: 0, minutes: 0, strain: 0 };
			s.count++; s.minutes += (Date.parse(w.end) - Date.parse(w.start)) / 60000; s.strain += Number(w.strain) || 0;
			bySport.set(w.sport, s);
			if (!oldest || w.start < oldest) oldest = w.start;
		}
		if (!dryRun) written += await workoutHistory.record(profileId, page.records);
	} while (nextToken);

	console.log(`${read} workouts over ${pages} page(s), oldest ${oldest || "—"}${dryRun ? " (dry run, nothing written)" : `, ${written} recorded`}`);
	console.table([...bySport].sort((a, b) => b[1].count - a[1].count).map(([sport, s]) => ({
		sport, count: s.count, avg_minutes: Math.round(s.minutes / s.count), avg_strain: Number((s.strain / s.count).toFixed(1)),
	})));
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
