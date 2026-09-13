#!/usr/bin/env node
/**
 * Athena's encryption-key rotation job.
 *
 *   node src/jobs/rotate-keys.js               mint a new key, re-encrypt, prune
 *   node src/jobs/rotate-keys.js --dry-run     report only; no secret or row writes
 *   node src/jobs/rotate-keys.js --reencrypt   no new key; just move rows onto the
 *                                              active key (use after adding a column)
 *   node src/jobs/rotate-keys.js --no-prune    keep retired keys on the keyring
 *   node src/jobs/rotate-keys.js --batch 500   rows per SELECT (default 200)
 *
 * Schedule it monthly (see docs/architecture/secret-rotation.md):
 * Cloud Run Job + Cloud Scheduler, mirroring the nightly review job.
 *
 * What it rotates: the AES-256-GCM keyring that encrypts secrets at rest in
 * MySQL (`ATHENA_ENC_KEYRING`). It does NOT rotate upstream credentials —
 * the Gemini key, the DB password, OAuth client secrets — because each of
 * those rotates through its own provider's API. Those stay manual runbook
 * steps in SECURITY_SETUP.md.
 *
 * Order matters, and is chosen so a concurrent API process is never wrong:
 *   1. publish the keyring with the NEW key active and every old key retained
 *   2. re-encrypt rows (old keys still decrypt; a stale reader that meets an
 *      unknown key id refetches the keyring — see crypto.decrypt)
 *   3. publish again with keys no row references removed
 * A row rewritten by the API mid-pass is skipped, not clobbered, and gets
 * picked up on the next run.
 *
 * Exit code is non-zero if rotation did not complete — this one is meant to
 * page, unlike the nightly review.
 */
require("dotenv").config();
const pool = require("../helpers/db");
const secrets = require("../services/secrets");
const {
	encrypt,
	decrypt,
	keyIdOf,
	generateKeyHex,
	legacyKeyHex,
	resetKeyringCache,
	KEYRING_SECRET,
	LEGACY_KEY_ID,
} = require("../helpers/crypto");

/**
 * Every column holding ciphertext. Adding an encrypted column anywhere means
 * adding it here, or rotation will silently leave it behind on a retired key.
 */
const ENCRYPTED_COLUMNS = [
	{ table: "integration_link", idColumn: "id", columns: ["access_token"] },
	{
		table: "user_credential",
		idColumn: "id",
		columns: ["access_token_enc", "refresh_token_enc"],
	},
];

const log = (...m) =>
	console.log(`[rotate ${new Date().toISOString().slice(11, 19)}]`, ...m);

function parseArgs(argv) {
	const args = { dryRun: false, reencryptOnly: false, prune: true, batch: 200 };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") args.dryRun = true;
		else if (a === "--reencrypt") args.reencryptOnly = true;
		else if (a === "--no-prune") args.prune = false;
		else if (a === "--batch") args.batch = Math.max(1, Number(argv[++i]) || 200);
		else throw new Error(`Unknown argument: ${a}`);
	}
	return args;
}

/** Table exists? Rotation should not fail on a migration that has not run yet. */
async function tableExists(table) {
	const [rows] = await pool.query(
		`SELECT 1 FROM information_schema.TABLES
		 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
		[table]
	);
	return rows.length > 0;
}

async function activeTargets() {
	const targets = [];
	for (const target of ENCRYPTED_COLUMNS) {
		if (await tableExists(target.table)) targets.push(target);
		else log(`skip ${target.table} — table not present`);
	}
	return targets;
}

/**
 * Walk every ciphertext row in batches, keyed by primary key so a long run
 * never holds a big result set or a long transaction.
 */
async function eachRow(target, batch, visit) {
	const { table, idColumn, columns } = target;
	const select = [idColumn, ...columns].map((c) => `\`${c}\``).join(", ");
	let cursor = 0;
	for (;;) {
		const [rows] = await pool.query(
			`SELECT ${select} FROM \`${table}\`
			 WHERE \`${idColumn}\` > ? ORDER BY \`${idColumn}\` LIMIT ?`,
			[cursor, batch]
		);
		if (!rows.length) return;
		for (const row of rows) await visit(row);
		cursor = rows[rows.length - 1][idColumn];
	}
}

// ---------------------------------------------------------------------------
// Keyring publication
// ---------------------------------------------------------------------------

/** Next key id: k1, k2, ... one past the highest numeric id on the keyring. */
function nextKeyId(keys) {
	let max = 0;
	for (const id of Object.keys(keys)) {
		const m = /^k(\d+)$/.exec(id);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `k${max + 1}`;
}

async function readKeyring() {
	const raw = await secrets.getSecretJson(KEYRING_SECRET, { forceRefresh: true });
	if (raw && typeof raw === "object" && raw.keys) return raw;
	// First run: no keyring yet. Seed it with the pre-keyring derived key so
	// existing v1 ciphertext stays readable through the normal path.
	const legacy = legacyKeyHex();
	log(
		legacy
			? `no ${KEYRING_SECRET} yet — seeding one that retains the legacy key`
			: `no ${KEYRING_SECRET} yet — seeding a fresh one`
	);
	return { active: null, keys: legacy ? { [LEGACY_KEY_ID]: legacy } : {} };
}

async function publishKeyring(keyring, { dryRun }) {
	const payload = JSON.stringify(keyring);
	if (dryRun) {
		log(
			`dry run — would publish ${KEYRING_SECRET}: active=${keyring.active}, keys=[${Object.keys(keyring.keys).join(", ")}]`
		);
		return;
	}
	const version = await secrets.addSecretVersion(KEYRING_SECRET, payload);
	resetKeyringCache(); // this process must encrypt under the new active key
	log(
		`published ${KEYRING_SECRET}${version ? ` ${version.split("/").pop()}` : ""}: ` +
			`active=${keyring.active}, keys=[${Object.keys(keyring.keys).join(", ")}]`
	);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function reencrypt(targets, activeId, { dryRun, batch }) {
	const stats = { scanned: 0, rewritten: 0, skipped: 0, failed: 0 };

	for (const target of targets) {
		for (const column of target.columns) {
			await eachRow({ ...target, columns: [column] }, batch, async (row) => {
				const value = row[column];
				if (typeof value !== "string" || !value) return;
				stats.scanned++;
				if (keyIdOf(value) === activeId) return;

				try {
					const plaintext = await decrypt(value);
					if (dryRun) {
						stats.rewritten++;
						return;
					}
					const rewritten = await encrypt(plaintext);
					// Compare-and-swap: if the API rewrote this row since the
					// SELECT, leave its value alone and catch it next run.
					const [res] = await pool.query(
						`UPDATE \`${target.table}\` SET \`${column}\` = ?
						 WHERE \`${target.idColumn}\` = ? AND \`${column}\` = ?`,
						[rewritten, row[target.idColumn], value]
					);
					if (res.affectedRows === 1) stats.rewritten++;
					else stats.skipped++;
				} catch (err) {
					stats.failed++;
					console.error(
						`[rotate] ${target.table}.${column} id=${row[target.idColumn]} failed:`,
						err?.message || err
					);
				}
			});
		}
	}
	log(
		`re-encrypt: scanned ${stats.scanned}, rewritten ${stats.rewritten}, ` +
			`skipped ${stats.skipped}, failed ${stats.failed}`
	);
	return stats;
}

/** Key ids still referenced by at least one row. */
async function keyIdsInUse(targets, batch) {
	const inUse = new Set();
	for (const target of targets) {
		for (const column of target.columns) {
			await eachRow({ ...target, columns: [column] }, batch, (row) => {
				const id = keyIdOf(row[column]);
				if (id) inUse.add(id);
			});
		}
	}
	return inUse;
}

async function main() {
	const args = parseArgs(process.argv);
	const started = Date.now();
	log(args.dryRun ? "starting (dry run)" : "starting");

	const targets = await activeTargets();
	if (!targets.length) throw new Error("No encrypted columns found to rotate");

	const keyring = await readKeyring();
	let activeId = keyring.active;

	if (args.reencryptOnly) {
		if (!activeId) throw new Error("--reencrypt needs an existing keyring");
		log(`re-encrypt only; active key is ${activeId}`);
	} else {
		activeId = nextKeyId(keyring.keys);
		keyring.keys[activeId] = generateKeyHex();
		keyring.active = activeId;
		log(`minted ${activeId}`);
		// Step 1: new key active, every old key retained for decryption.
		await publishKeyring(keyring, args);
	}

	// Step 2. In a dry run nothing was published, so encrypt() would still use
	// the old active key — reencrypt() knows to only count in that mode.
	const stats = await reencrypt(targets, activeId, args);
	if (stats.failed > 0) {
		throw new Error(
			`${stats.failed} row(s) could not be re-encrypted; keeping every key on the keyring`
		);
	}

	// Step 3: drop keys nothing references any more.
	if (args.prune) {
		const inUse = await keyIdsInUse(targets, args.batch);
		const retired = Object.keys(keyring.keys).filter(
			(id) => id !== keyring.active && !inUse.has(id)
		);
		if (retired.length) {
			for (const id of retired) delete keyring.keys[id];
			log(`pruning retired keys: ${retired.join(", ")}`);
			await publishKeyring(keyring, args);
		} else {
			log("no retired keys to prune");
		}
	}

	log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
	.then(() => pool.end())
	.then(() => process.exit(0))
	.catch(async (err) => {
		console.error("[rotate] FAILED:", err?.message || err);
		try {
			await pool.end();
		} catch {
			/* already closing */
		}
		process.exit(1);
	});
