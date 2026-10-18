#!/usr/bin/env node
/**
 * One-off: link Athena's own Google account (EMAIL_ADDRESS) to Google Keep, so
 * she can read the lists people share with her — the family grocery list
 * first. The credential is stored on the profile of the person who shared the
 * list (the first argument), the same as any connector that person linked.
 *
 * Keep has no API for consumer accounts, so this uses gkeepapi's master token
 * (scripts/keep/keep_helper.py). Getting one needs a sign-in only a person can
 * do — nobody types Athena's password into a script:
 *
 *   1. In a private browser window, open https://accounts.google.com/EmbeddedSetup
 *      and sign in as Athena. Accept the terms if asked (the page may then spin
 *      forever; that's fine).
 *   2. DevTools → Application → Cookies → accounts.google.com → copy the value
 *      of `oauth_token` (starts "oauth2_4/"). It works once, for a few minutes.
 *   3. In PowerShell:  $env:KEEP_OAUTH_TOKEN = "<paste>"
 *      node scripts/addKeepLogin.js you@example.com             # verify + store
 *      node scripts/addKeepLogin.js you@example.com --dry-run   # verify only
 *
 * Prints the lists Athena can see and their item counts, never a token, then
 * reads them again through src/services/connectors/googleKeep.js — the path
 * production uses. Afterwards:  node scripts/addKeepLogin.js you@example.com --show
 * repeats that read with the stored credential.
 */
require("dotenv").config();
const { spawn } = require("node:child_process");
const path = require("node:path");
const pool = require("../src/helpers/db");
const credentials = require("../src/services/credentials");

const KEEP_DIR = path.join(__dirname, "keep");
const PYTHON = process.env.KEEP_PYTHON || path.join(KEEP_DIR, ".venv", "Scripts", "python.exe");

function helper(request) {
	return new Promise((resolve, reject) => {
		const child = spawn(PYTHON, [path.join(KEEP_DIR, "keep_helper.py")], { stdio: ["pipe", "pipe", "inherit"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.on("error", reject);
		child.on("close", () => {
			try {
				const reply = JSON.parse(out);
				if (reply.error) reject(new Error(`Keep: ${reply.error}`));
				else resolve(reply);
			} catch {
				reject(new Error("Keep helper returned no JSON"));
			}
		});
		child.stdin.end(JSON.stringify(request));
	});
}

function summarize(lists) {
	console.log(`Athena can see ${lists.length} list(s):`);
	for (const list of lists) {
		const open = list.items.filter((i) => !i.checked);
		console.log(`- "${list.title || "(untitled)"}": ${open.length} to get, ${list.items.length - open.length} ticked off` +
			(list.collaborators ? `, shared with ${list.collaborators}` : ""));
		if (/grocer|shopping|food/i.test(list.title || "")) {
			for (const item of open) console.log(`    [ ] ${item.text}`);
			const recent = list.items.filter((i) => i.checked).sort((a, b) => (b.updated || "").localeCompare(a.updated || "")).slice(0, 15);
			for (const item of recent) console.log(`    [x] ${item.text}  (ticked ${String(item.updated).slice(0, 10)})`);
		}
	}
}

/**
 * Ask for the cookie without echoing it, so it lands in neither the terminal's
 * scrollback nor shell history. An env var set in another window is invisible
 * here, which is the usual reason KEEP_OAUTH_TOKEN "isn't set".
 */
function askHidden(question) {
	if (!process.stdin.isTTY) return Promise.resolve("");
	const readline = require("node:readline");
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	rl._writeToOutput = (text) => {
		if (text.includes(question)) process.stdout.write(text);
	};
	return new Promise((resolve) =>
		rl.question(question, (answer) => {
			rl.close();
			process.stdout.write("\n");
			resolve(answer);
		})
	);
}

/**
 * Read again the way Athena will in production: the Node connector, no Python.
 * Google is particular about the client it hands Keep tokens to, so this is
 * the check that the production path works, not just the helper.
 */
async function readThroughConnector(profileId) {
	const keep = require("../src/services/connectors/googleKeep");
	const lists = await keep.listLists(profileId);
	console.log(`\nRead through Athena's own connector (what production runs): ${lists.length} list(s).`);
	console.log(keep.formatBlock(keep.foodSummary(lists)));
}

(async () => {
	const account = String(process.argv[2] || "").trim().toLowerCase();
	const dryRun = process.argv.includes("--dry-run");
	const show = process.argv.includes("--show");
	const email = (process.env.EMAIL_ADDRESS || "").trim().toLowerCase();
	if (!account || !email) throw new Error("Usage: addKeepLogin.js <your profile email> [--dry-run | --show]; needs EMAIL_ADDRESS in .env");

	const [rows] = await pool.query("SELECT id FROM profile WHERE LOWER(email) = ?", [account]);
	if (rows.length !== 1) throw new Error(`Expected exactly one profile for ${account}, found ${rows.length}`);
	const profileId = rows[0].id;

	if (show) {
		await readThroughConnector(profileId);
		return;
	}

	const oauthToken = (process.env.KEEP_OAUTH_TOKEN || (await askHidden("Paste the oauth_token cookie (it won't be shown): "))).trim();
	if (!oauthToken) throw new Error("No oauth_token given (see the comment at the top for where to find it).");
	const { master_token: masterToken } = await helper({ cmd: "exchange", email, oauth_token: oauthToken });
	console.log(`Signed in to Keep as ${email}.`);
	summarize((await helper({ cmd: "lists", email, master_token: masterToken })).lists);

	if (dryRun) {
		console.log("Dry run: nothing stored.");
		return;
	}
	const saved = await credentials.put({
		profileId, provider: "google_keep", kind: "api_key",
		externalAccountId: email, displayName: email,
		accessToken: masterToken, actor: "owner-script",
	});
	console.log(`Stored Keep credential (${saved.status}) on ${account}'s profile.`);
	await readThroughConnector(profileId);
})().catch((err) => {
	console.error(err.message);
	process.exitCode = 1;
}).finally(() => pool.end && pool.end());
