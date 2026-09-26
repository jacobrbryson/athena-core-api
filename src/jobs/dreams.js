#!/usr/bin/env node
/**
 * Read the Dreams log — what Athena did in athena_mind, night by night.
 *
 *   npm run dreams                  the last 30 days, one line per night
 *   npm run dreams -- <uuid|date>   one night in full: every statement, in order
 *   npm run dreams -- questions     questions waiting on people, and answers
 *
 * Read-only. The log itself lives in the main database (athena_dream,
 * athena_dream_step, athena_dream_question) and keeps 30 days.
 */
require("dotenv").config();
const pool = require("../helpers/db");

const d = (v) => (v instanceof Date ? v.toISOString().replace("T", " ").slice(0, 16) : String(v ?? "").slice(0, 16));

async function list() {
	const [rows] = await pool.query(
		`SELECT uuid, dream_date, status, stats, summary FROM athena_dream ORDER BY started_at DESC LIMIT 60`
	);
	if (!rows.length) return console.log("No dreams yet.");
	for (const r of rows) {
		const s = typeof r.stats === "string" ? JSON.parse(r.stats) : r.stats || {};
		console.log(
			`${String(r.dream_date instanceof Date ? r.dream_date.toISOString() : r.dream_date).slice(0, 10)}  ${r.status.padEnd(8)} ` +
				`steps ${s.steps_ok ?? 0}/${(s.steps_ok ?? 0) + (s.steps_failed ?? 0)}  purged ${s.purged ?? 0}  asked ${s.questions_asked ?? 0}  ${r.uuid}`
		);
		if (r.summary) console.log(`    ${String(r.summary).replace(/\s+/g, " ").slice(0, 300)}`);
	}
}

async function show(key) {
	// A date names that day's latest night; anything else is a uuid.
	const byDate = /^\d{4}-\d{2}-\d{2}$/.test(key);
	const [[night]] = await pool.query(
		`SELECT * FROM athena_dream WHERE ${byDate ? "dream_date" : "uuid"} = ? ORDER BY started_at DESC LIMIT 1`,
		[key]
	);
	if (!night) return console.log(`No dream matching ${key}.`);
	console.log(`Dream ${night.uuid} — ${night.status}, ${d(night.started_at)} → ${d(night.finished_at)}, ${night.served_by || "no model"}`);
	console.log(`\n${night.summary || "(no summary)"}\n`);
	const [steps] = await pool.query(`SELECT * FROM athena_dream_step WHERE dream_id = ? ORDER BY seq`, [night.id]);
	for (const s of steps) {
		console.log(`#${s.seq} r${s.round} ${s.kind}${s.ok ? "" : " FAILED"}${s.affected_rows != null ? ` (${s.affected_rows})` : ""}${s.ms != null ? ` ${s.ms}ms` : ""}`);
		if (s.why) console.log(`   why: ${s.why}`);
		if (s.statement) console.log(`   ${String(s.statement).split("\n").join("\n   ")}`);
		if (s.error) console.log(`   error: ${s.error}`);
	}
}

async function listQuestions() {
	const [rows] = await pool.query(
		`SELECT profile_id, status, question, answer, created_at, offered_at FROM athena_dream_question ORDER BY created_at DESC LIMIT 100`
	);
	if (!rows.length) return console.log("No questions.");
	for (const r of rows) {
		console.log(`${d(r.created_at)}  p${r.profile_id}  ${r.status.padEnd(9)} ${r.question}`);
		if (r.answer) console.log(`    → ${r.answer}`);
	}
}

async function main() {
	const arg = process.argv[2];
	if (!arg) await list();
	else if (arg === "questions") await listQuestions();
	else await show(arg);
}

main()
	.catch((err) => {
		console.error("[dreams]", err.message);
		process.exitCode = 1;
	})
	.finally(() => pool.end().catch(() => undefined));
