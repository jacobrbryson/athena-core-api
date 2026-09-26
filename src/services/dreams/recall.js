/**
 * The daytime side of dreaming: what the chat prompt gets from athena_mind.
 *
 * Every query here is built by this code and parameterized. The model's own
 * SQL never runs in the chat path — it runs only in the nightly dream, on her
 * restricted connection. This file reads her tables through the main pool
 * with schema-qualified names, and only ever this person's rows
 * (`_profile_id = ?`). A table or view without `_profile_id` is invisible here.
 *
 * Per turn, the block carries:
 *   - her waiting questions for this person, with how to ask them;
 *   - the catalog index ("tables I've organized"), so she knows they exist;
 *   - rows from tables the message is about — by a trigger word ("people")
 *     or by naming something in a label column ("Emma");
 *   - last night's dream summary when the person asks about her dreams.
 *
 * Never throws and is time-boxed: a missing athena_mind costs this block,
 * never the reply.
 */
const pool = require("../../helpers/db");
const { MIND_DB, IDENT } = require("./mind");
const questions = require("./questions");

const BUDGET_MS = 600;
const CATALOG_TTL_MS = 5 * 60_000;
const LABEL_TTL_MS = 2 * 60_000;
const ROWS_PER_OBJECT = 30;
const DREAM_WORDS = /\b(dream|dreams|dreaming|dreamt|dreamed|last night)\b/i;

let catalogCache = { at: 0, value: null };
const labelCache = new Map(); // `${profileId}:${object}` -> { at, labels }

const q = (name) => `\`${MIND_DB}\`.\`${name}\``;

/** Her catalog, joined against the columns that actually exist. */
async function catalog() {
	if (catalogCache.value && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value;
	let value = [];
	try {
		const [entries] = await pool.query(`SELECT object_name, description, label_column, triggers FROM ${q("_catalog")}`);
		const [cols] = await pool.query(
			`SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?`,
			[MIND_DB]
		);
		const byTable = new Map();
		for (const { t, c } of cols) {
			if (!byTable.has(t)) byTable.set(t, new Set());
			byTable.get(t).add(c);
		}
		value = entries
			.filter((e) => IDENT.test(e.object_name) && byTable.get(e.object_name)?.has("_profile_id"))
			.map((e) => {
				const columns = byTable.get(e.object_name);
				let triggers = e.triggers;
				if (typeof triggers === "string") {
					try {
						triggers = JSON.parse(triggers);
					} catch {
						triggers = [];
					}
				}
				return {
					object: e.object_name,
					description: e.description,
					label: e.label_column && columns.has(e.label_column) ? e.label_column : null,
					triggers: Array.isArray(triggers) ? triggers.map((t) => String(t).toLowerCase()) : [],
				};
			});
	} catch {
		value = []; // athena_mind not set up yet, or unreadable — silence, not an error per turn
	}
	catalogCache = { at: Date.now(), value };
	return value;
}

async function labelsFor(profileId, entry) {
	const key = `${profileId}:${entry.object}`;
	const hit = labelCache.get(key);
	if (hit && Date.now() - hit.at < LABEL_TTL_MS) return hit.labels;
	const [rows] = await pool.query(
		`SELECT DISTINCT \`${entry.label}\` AS l FROM ${q(entry.object)} WHERE _profile_id = ? LIMIT 500`,
		[profileId]
	);
	const labels = rows.map((r) => String(r.l ?? "").trim()).filter((l) => l.length >= 3);
	labelCache.set(key, { at: Date.now(), labels });
	return labels;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (message, word) => new RegExp(`\\b${escapeRe(word)}\\b`, "i").test(message);

function formatRow(row) {
	return Object.entries(row)
		.filter(([k, v]) => !k.startsWith("_") && v !== null && v !== "")
		.map(([k, v]) => `${k}: ${v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "object" ? JSON.stringify(v) : v}`)
		.join("; ")
		.slice(0, 400);
}

async function rowsFor(profileId, entry, labelValue = null) {
	const [rows] = labelValue
		? await pool.query(`SELECT * FROM ${q(entry.object)} WHERE _profile_id = ? AND \`${entry.label}\` = ? LIMIT 5`, [profileId, labelValue])
		: await pool.query(`SELECT * FROM ${q(entry.object)} WHERE _profile_id = ? LIMIT ?`, [profileId, ROWS_PER_OBJECT]);
	return rows;
}

async function organizedSection(profileId, message) {
	const entries = await catalog();
	if (!entries.length) return null;
	const text = String(message || "");
	const sections = [];
	for (const entry of entries) {
		if (sections.length >= 3) break;
		try {
			if (entry.triggers.some((t) => mentions(text, t))) {
				const rows = await rowsFor(profileId, entry);
				if (rows.length) sections.push(`${entry.object} (${entry.description}):\n${rows.map((r) => `- ${formatRow(r)}`).join("\n")}`);
				continue;
			}
			if (entry.label) {
				const named = (await labelsFor(profileId, entry)).filter((l) => mentions(text, l)).slice(0, 3);
				const rows = [];
				for (const l of named) rows.push(...(await rowsFor(profileId, entry, l)));
				if (rows.length) sections.push(`${entry.object} (${entry.description}):\n${rows.map((r) => `- ${formatRow(r)}`).join("\n")}`);
			}
		} catch {
			/* one broken view costs itself, not the block */
		}
	}
	const index = entries.map((e) => `${e.object} — ${e.description}`).join("; ");
	return (
		`**What I've organized while dreaming** (my own tables, built from what this person has told me): ${index}.` +
		(sections.length
			? `\nRelevant rows for this message — use them when they answer the question, and say so plainly if a list may be incomplete:\n${sections.join("\n\n")}`
			: "")
	);
}

async function questionsSection(profileId, sessionId) {
	const waiting = await questions.pendingFor(profileId, 3);
	if (!waiting.length) return null;
	await questions.markOffered(
		waiting.map((w) => w.id),
		sessionId
	).catch(() => undefined);
	return `**Questions from your dreaming.** While organizing your memories last night you couldn't settle these on your own:
${waiting.map((w) => `- "${w.question}"`).join("\n")}
At a natural pause — not in the middle of something urgent or emotional, and not if the person is busy — ask ONE of them, opening softly, e.g. "Can I ask you something?" or "Could you clarify something for me?". If the conversation history shows you already asked it, don't ask again; take their reply as the answer. If they'd rather not, drop it gracefully.`;
}

async function dreamSection(message) {
	if (!DREAM_WORDS.test(String(message || ""))) return null;
	const [[row]] = await pool.query(
		`SELECT dream_date, status, summary FROM athena_dream WHERE status IN ('ok', 'partial') ORDER BY started_at DESC LIMIT 1`
	);
	if (!row?.summary) return null;
	return `**Your most recent dream** (${String(row.dream_date).slice(0, 10)}), in your own words from the Dreams log: ${String(row.summary).slice(0, 1200)}`;
}

async function build(profileId, message, sessionId) {
	const parts = await Promise.all([
		questionsSection(profileId, sessionId).catch(() => null),
		organizedSection(profileId, message).catch(() => null),
		dreamSection(message).catch(() => null),
	]);
	const text = parts.filter(Boolean).join("\n\n");
	return text || null;
}

/** The chat prompt block for an ADULT session, or null. */
async function promptBlock(profileId, message, { sessionId = null } = {}) {
	if (!profileId) return null;
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(null), BUDGET_MS);
	});
	try {
		return await Promise.race([build(Number(profileId), message, sessionId).catch(() => null), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function _reset() {
	catalogCache = { at: 0, value: null };
	labelCache.clear();
}

module.exports = { promptBlock, catalog, formatRow, _reset };
