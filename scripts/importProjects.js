#!/usr/bin/env node
/**
 * Seed one profile's projects from a reviewed import file.
 *
 *   node scripts/importProjects.js <profileId> <file.json>              # dry run: what it would create
 *   node scripts/importProjects.js <profileId> <file.json> --apply      # write
 *   node scripts/importProjects.js <profileId> <file.json> --apply --overwrite
 *
 * A one-time seed — after it runs, the Companion app is the source of truth. A
 * re-run only creates what is missing and never overwrites an edit. --overwrite
 * deletes this file's rows first and is for a botched first run only. Refuses
 * to --apply while the file still carries a "review" question.
 * See src/services/projects/importFile.js.
 */
require("dotenv").config();
const fs = require("node:fs");
const pool = require("../src/helpers/db");
const { importFile } = require("../src/services/projects/importFile");

async function main() {
	const args = process.argv.slice(2);
	const profileId = Number(args[0]);
	const path = args[1];
	if (!Number.isSafeInteger(profileId) || profileId <= 0 || !path) {
		throw new Error("Usage: importProjects.js <profileId> <file.json> [--apply] [--overwrite]");
	}
	const apply = args.includes("--apply");
	const overwrite = args.includes("--overwrite");
	if (overwrite && !apply) throw new Error("--overwrite only means something with --apply.");
	const file = JSON.parse(fs.readFileSync(path, "utf8"));

	const s = await importFile(profileId, file, { apply, overwrite });
	console.log(apply ? `Imported into profile ${profileId} (${s.area}).` : `Dry run for profile ${profileId} (${s.area}) — nothing written.`);
	console.log(`  charter:  ${s.charter}`);
	console.log(`  projects: ${s.projects.created.length} ${apply ? "created" : "to create"}, ${s.projects.skipped.length} already there`);
	console.log(`  steps:    ${s.steps}, links: ${s.links} (for new projects only)`);
	console.log(`  concerns: ${s.concerns.created.length} ${apply ? "created" : "to create"}, ${s.concerns.skipped.length} already there`);
	if (s.reviews.length) console.log(`\n${s.reviews.length} review question(s) still open:\n- ${s.reviews.join("\n- ")}`);
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
