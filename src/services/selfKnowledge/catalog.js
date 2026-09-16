const fs = require("fs");
const path = require("path");

/**
 * Athena's self-knowledge catalog — she knows what she can do, and where in
 * the product the person turns it on.
 *
 * Every user-visible capability is described by exactly one Markdown file in
 * `docs/capabilities/`. Those files are the single source of truth for two
 * different readers:
 *
 *   - Athena herself. Selected sections are appended to her system prompt for
 *     the turn, so "can you read my calendar?" is answered from what the
 *     product actually does — including the menu path to switch it on and
 *     what to try when it breaks — instead of from a guess.
 *   - Coding agents. `## Under the hood` names the files, routes and tests
 *     behind the feature. That section is NEVER sent to a model; it is the
 *     map a future agent reads before changing the thing.
 *
 * Adding a capability is a file, not a code change. The contract that keeps
 * it that way lives in `docs/capabilities/README.md`, and
 * `selfKnowledge.test.js` enforces it.
 */

const DOCS_DIR = path.resolve(__dirname, "../../../docs/capabilities");

// Sections that may reach a model, in the order they are rendered. Anything
// else in the file (notably `## Under the hood`) is agent-only. An allowlist
// rather than a blocklist, so a new section added tomorrow is private by
// default and cannot leak internals into a child's conversation.
const USER_SECTIONS = [
	"What I can do",
	"Where to find it",
	"When it doesn't work",
	"Limits",
];

// A capability is only spoken about when it actually exists. `planned` docs
// are written early so an agent has somewhere to put the design, and stay out
// of every prompt until the status flips.
const SPOKEN_STATUSES = new Set(["live", "partial"]);

const VALID_STATUSES = new Set(["live", "partial", "planned"]);
const VALID_SURFACES = new Set(["companion", "guardians", "learning"]);
const VALID_AUDIENCES = new Set(["adult", "child"]);

const REQUIRED_META = ["id", "title", "summary", "status", "surfaces", "triggers"];

/** `key: value` frontmatter. Deliberately tiny — no YAML dependency. */
function parseValue(raw) {
	const t = raw.trim();
	if (t.startsWith("[") && t.endsWith("]")) {
		return t
			.slice(1, -1)
			.split(",")
			.map((s) => s.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	}
	return t.replace(/^["']|["']$/g, "");
}

function parseFrontmatter(raw) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	if (!m) return { meta: {}, body: raw };
	const meta = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
		if (kv) meta[kv[1]] = parseValue(kv[2]);
	}
	return { meta, body: raw.slice(m[0].length) };
}

/** `## Heading` -> content, preserving the order the author wrote them in. */
function parseSections(body) {
	const sections = new Map();
	const re = /^##\s+(.+?)[ \t]*$/gm;
	let match;
	let pending = null;
	while ((match = re.exec(body)) !== null) {
		if (pending) sections.set(pending.title, body.slice(pending.start, match.index).trim());
		pending = { title: match[1].trim(), start: re.lastIndex };
	}
	if (pending) sections.set(pending.title, body.slice(pending.start).trim());
	return sections;
}

function parseCapability(file, raw) {
	const { meta, body } = parseFrontmatter(raw);
	const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
	return {
		file,
		id: meta.id || "",
		title: meta.title || "",
		summary: meta.summary || "",
		// One-line UI path. Rides along in the always-present index so Athena
		// can point someone at the right menu even for a capability whose full
		// detail didn't make this turn's budget.
		where: meta.where || "",
		status: meta.status || "",
		surfaces: list(meta.surfaces),
		audiences: list(meta.audiences).length ? list(meta.audiences) : ["adult", "child"],
		triggers: list(meta.triggers).map((t) => t.toLowerCase()),
		sections: parseSections(body),
	};
}

/**
 * Problems that make a capability file unusable or, worse, quietly wrong.
 * Returned as strings so the test can print all of them at once instead of
 * failing on the first.
 */
function validate(cap) {
	const problems = [];
	const expectedId = path.basename(cap.file, ".md");
	for (const key of REQUIRED_META) {
		const value = cap[key];
		if (!value || (Array.isArray(value) && !value.length)) {
			problems.push(`${cap.file}: missing frontmatter "${key}"`);
		}
	}
	if (cap.id && cap.id !== expectedId) {
		problems.push(`${cap.file}: id "${cap.id}" must match the filename "${expectedId}"`);
	}
	if (cap.status && !VALID_STATUSES.has(cap.status)) {
		problems.push(
			`${cap.file}: status "${cap.status}" is not one of ${[...VALID_STATUSES].join(", ")}`
		);
	}
	for (const s of cap.surfaces) {
		if (!VALID_SURFACES.has(s)) problems.push(`${cap.file}: unknown surface "${s}"`);
	}
	for (const a of cap.audiences) {
		if (!VALID_AUDIENCES.has(a)) problems.push(`${cap.file}: unknown audience "${a}"`);
	}
	if (cap.summary.length > 160) {
		problems.push(
			`${cap.file}: summary is ${cap.summary.length} chars; keep it under 160 (it rides in every prompt)`
		);
	}
	// A capability Athena will speak about has to say what it does, where it
	// lives, and what it can't do. Skipping "Limits" is how she starts
	// overpromising, so it is required rather than encouraged.
	if (SPOKEN_STATUSES.has(cap.status)) {
		for (const heading of ["What I can do", "Where to find it", "Limits"]) {
			if (!cap.sections.get(heading)) {
				problems.push(`${cap.file}: missing section "## ${heading}"`);
			}
		}
	}
	if (!cap.sections.get("Under the hood")) {
		problems.push(`${cap.file}: missing section "## Under the hood" (the map for coding agents)`);
	}
	return problems;
}

let cache = null;

function fingerprint() {
	let stamp = "";
	for (const name of fs.readdirSync(DOCS_DIR).sort()) {
		if (!name.endsWith(".md")) continue;
		const { mtimeMs, size } = fs.statSync(path.join(DOCS_DIR, name));
		stamp += `${name}:${mtimeMs}:${size};`;
	}
	return stamp;
}

/** Documentation ABOUT the system (README, LEDGER, _template) isn't a capability. */
function isCapabilityFile(name) {
	if (!name.endsWith(".md") || name.startsWith("_")) return false;
	const base = name.slice(0, -3);
	// README / LEDGER and friends are SHOUTED; capability files are kebab-case.
	return base !== base.toUpperCase();
}

/**
 * Every capability file, parsed. Cached; outside production the cache is
 * revalidated against file mtimes so editing a doc shows up on the next
 * message without a restart.
 */
function loadCatalog() {
	let stamp = null;
	try {
		stamp = fingerprint();
	} catch {
		// No docs directory (a trimmed image, a test fixture). Self-knowledge is
		// an enhancement — an absent catalog must never break a conversation.
		cache = { stamp: null, capabilities: [] };
		return cache.capabilities;
	}
	if (cache && (process.env.NODE_ENV === "production" || cache.stamp === stamp)) {
		return cache.capabilities;
	}

	const capabilities = [];
	for (const name of fs.readdirSync(DOCS_DIR).sort()) {
		if (!isCapabilityFile(name)) continue;
		try {
			const cap = parseCapability(name, fs.readFileSync(path.join(DOCS_DIR, name), "utf8"));
			const problems = validate(cap);
			if (problems.length) {
				// Loud, but never fatal: a malformed doc costs Athena knowledge of
				// one feature, not the ability to reply.
				console.warn(`[selfKnowledge] ${problems.join("; ")}`);
			}
			if (cap.id) capabilities.push(cap);
		} catch (e) {
			console.warn(`[selfKnowledge] could not read ${name}: ${e.message}`);
		}
	}
	cache = { stamp, capabilities };
	return capabilities;
}

module.exports = {
	DOCS_DIR,
	USER_SECTIONS,
	SPOKEN_STATUSES,
	isCapabilityFile,
	loadCatalog,
	parseCapability,
	validate,
};
