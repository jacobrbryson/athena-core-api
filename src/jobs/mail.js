#!/usr/bin/env node
/**
 * Mail: keep every Mail card in step with its Gmail inbox, and sort new mail.
 *
 *   node src/jobs/mail.js            one pass over everyone who uses Mail
 *   node src/jobs/mail.js --status   each profile's cursor and last pass, reading nothing
 *   node src/jobs/mail.js --loop 900 a pass every 900s until stopped
 *
 * Scheduled every 15 minutes (deploy/scripts/setup-mail-sync.sh). Per profile:
 * an incremental sync (services/emailSync.js), the daily reconcile backstop,
 * re-sorting of up to 50 rows the old classifier left as 'other', then
 * classification of up to 100 pending rows — the only step that uses a
 * model, which is why each profile's pass runs inside its own access context
 * and stops at a denied check like any other model call.
 *
 * Who is covered: profiles with an email_sync_state row (created the first
 * time their dashboard shows the Mail card) that still have an active Gmail
 * link and an adult audience. The backlog is never touched here — that stays
 * on the "Scan more" button. Nothing is moved, labeled or deleted in Gmail.
 *
 * Exits 0 when a profile's pass fails (logged, retried next time); only an
 * unexpected failure of the job itself exits 1.
 */
require("dotenv").config();
const pool = require("../helpers/db");
const access = require("../security/access");
const { audienceForProfile } = require("../services/audience");
const emailSync = require("../services/emailSync");
const emailTriage = require("../services/emailTriage");

const args = { loop: 0, status: false };
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a === "--status") args.status = true;
	else if (a === "--loop") args.loop = Math.max(60, Number(process.argv[++i]) || 900);
}

const log = (...m) => console.log(`[mail ${new Date().toISOString().slice(11, 19)}]`, ...m);

async function profiles() {
	const [rows] = await pool.query(
		`SELECT s.profile_id, s.history_id, s.synced_at, s.reconciled_at, s.last_error, p.google_id
		   FROM email_sync_state s
		   JOIN profile p ON p.id = s.profile_id
		  WHERE EXISTS (SELECT 1 FROM user_credential c
		                 WHERE c.profile_id = s.profile_id AND c.provider = 'gmail' AND c.status = 'active')`
	);
	return rows;
}

async function status() {
	for (const p of await profiles()) {
		log(
			`profile ${p.profile_id}: cursor ${p.history_id || "none"}; synced ${p.synced_at ? new Date(p.synced_at).toISOString() : "never"}; ` +
				`reconciled ${p.reconciled_at ? new Date(p.reconciled_at).toISOString() : "never"}` +
				(p.last_error ? `; last error: ${p.last_error}` : "")
		);
	}
}

async function passFor(p) {
	if ((await audienceForProfile(p.profile_id)) !== "adult") return log(`profile ${p.profile_id}: not an adult profile; skipped`);
	if (!p.google_id) return log(`profile ${p.profile_id}: no Google identity to charge model use to; skipped`);
	await access.context.run({ identity: { google_id: p.google_id } }, async () => {
		await access.assertModelAccess();
		const synced = await emailSync.sync(p.profile_id, { verifyLimit: 100 });
		const reconciled = await emailSync.reconcileIfDue(p.profile_id);
		// Rows the old four-bucket classifier called 'other' go back through the
		// new one, 50 a pass, until none are left (phase 2 bundles need them).
		const resorted = await emailTriage.resortOld(p.profile_id, { limit: 50 });
		const sorted = await emailTriage.classifyPending(p.profile_id, { limit: 100 });
		log(`profile ${p.profile_id}: sync ${JSON.stringify(synced)}; reconcile ${JSON.stringify(reconciled)}; re-sorting ${resorted}; sorted ${sorted.classified}`);
	});
}

async function pass() {
	if (args.status) return status();
	for (const p of await profiles()) {
		try {
			await passFor(p);
		} catch (err) {
			log(`profile ${p.profile_id}: failed — ${err?.code || ""} ${err?.message || err}`);
		}
	}
}

(async () => {
	try {
		do {
			await pass();
			if (args.loop) await new Promise((r) => setTimeout(r, args.loop * 1000));
		} while (args.loop && !args.status);
	} catch (err) {
		log("job failed:", err?.stack || err);
		process.exitCode = 1;
	} finally {
		await pool.end().catch(() => {});
		process.exit(process.exitCode || 0);
	}
})();
