/**
 * Getting an existing list of house projects out of a spreadsheet and into
 * Athena, once.
 *
 * This is an import, not an integration: it runs when a person pastes or
 * uploads their rows, and then it is over. That is the whole reason the
 * projects moved out of the sheet — a live Sheets link would mean a Google
 * scope, a re-consent, and a column layout we would have to keep guessing at
 * forever, in exchange for data Athena still could not act on.
 *
 * Header mapping is forgiving because a real spreadsheet says "Task", "To Do",
 * "Est. Hours" and "Where" rather than our field names. Anything it cannot
 * place is reported back rather than dropped silently, so the person can see
 * what did not come across instead of discovering it missing later.
 */
const homeProjects = require("./homeProjects");

const MAX_ROWS = 300;
const MAX_TEXT = 512 * 1024;

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * RFC4180-ish: quoted fields, doubled quotes, newlines inside quotes, and
 * tab-separated input too — a spreadsheet copied to the clipboard is TSV, and
 * telling someone their paste was the wrong flavour of delimiter is not an
 * answer anyone wants.
 */
function parseDelimited(text) {
	const body = String(text || "").replace(/^﻿/, "");
	if (body.length > MAX_TEXT) throw bad("That is a lot of rows — paste up to a few hundred at a time.");
	const head = body.slice(0, body.indexOf("\n") + 1 || body.length);
	const delimiter = (head.match(/\t/g)?.length || 0) > (head.match(/,/g)?.length || 0) ? "\t" : ",";
	const rows = [];
	let row = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < body.length; i += 1) {
		const ch = body[i];
		if (quoted) {
			if (ch !== '"') { field += ch; continue; }
			if (body[i + 1] === '"') { field += '"'; i += 1; continue; }
			quoted = false;
			continue;
		}
		if (ch === '"' && field === "") { quoted = true; continue; }
		if (ch === delimiter) { row.push(field); field = ""; continue; }
		if (ch === "\r") continue;
		if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
		field += ch;
	}
	if (field !== "" || row.length) { row.push(field); rows.push(row); }
	return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Header text -> our field. The first pattern that matches a column wins. */
const HEADERS = [
	["title", /^(title|task|project|item|job|name|what|description of work)\b/i],
	["area", /^(area|room|location|where|zone|space|category)\b/i],
	["status", /^(status|state|progress|done\??)\b/i],
	["priority", /^(priority|importance|urgency|pri)\b/i],
	["effortMinutes", /^(effort|time|duration|est\.?\s*(hours|time|minutes)|hours|hrs|minutes|mins|how long)\b/i],
	["indoor", /^(indoor|inside|inside\/outside|in\/out|weather|indoor\?)\b/i],
	["costEstimate", /^(cost|budget|estimate|price|\$)\b/i],
	["dueDate", /^(due|deadline|by|target( date)?|date)\b/i],
	["blockedOn", /^(blocked|blocker|waiting( on)?|depends on)\b/i],
	["detail", /^(notes?|detail|comments?|description)\b/i],
];

function mapHeaders(cells) {
	const mapping = [];
	const taken = new Set();
	for (const cell of cells) {
		const header = String(cell || "").trim();
		const hit = HEADERS.find(([field, pattern]) => !taken.has(field) && pattern.test(header));
		if (hit) taken.add(hit[0]);
		mapping.push(hit ? hit[0] : null);
	}
	return mapping;
}

/**
 * A header row is only a header row if it names at least a title column and
 * carries no obviously-data cells. A list that starts straight in with
 * "Replace porch light" has no header, and guessing one would eat the first
 * project.
 */
function looksLikeHeader(mapping, cells) {
	if (!mapping.includes("title")) return false;
	return cells.every((cell) => String(cell || "").trim().length <= 40);
}

const TRUE = /^(y|yes|true|1|indoor|inside|in)$/i;
const FALSE = /^(n|no|false|0|outdoor|outside|out)$/i;

/** "2 hrs", "90 min", "1.5" (hours, because a spreadsheet means hours). */
function effortToMinutes(value) {
	const text = String(value || "").trim().toLowerCase();
	if (!text) return null;
	const n = Number(text.replace(/[^\d.]/g, ""));
	if (!Number.isFinite(n) || n <= 0) return null;
	if (/\b(m|min|mins|minute|minutes)\b/.test(text)) return Math.round(n);
	if (/\b(d|day|days)\b/.test(text)) return Math.round(n * 8 * 60);
	if (/\b(w|wk|week|weeks)\b/.test(text)) return Math.round(n * 5 * 8 * 60);
	return Math.round(n * 60);
}

function statusFrom(value) {
	const text = String(value || "").trim().toLowerCase();
	if (!text) return "todo";
	if (/^(done|complete|completed|finished|closed|yes|y|x|✓)$/.test(text)) return "done";
	// Before the "started" test, because "Not started" contains it and is the
	// single most common thing a spreadsheet says about work nobody has begun.
	if (/^(not |un)?(started|begun)$|^(todo|to do|open|new|backlog|planned)$/.test(text)) {
		return /^(started|begun)$/.test(text) ? "in_progress" : "todo";
	}
	if (/(progress|started|doing|wip|underway|ongoing)/.test(text)) return "in_progress";
	if (/(block|waiting|hold|stuck|someday|later)/.test(text)) return "blocked";
	return "todo";
}

function priorityFrom(value) {
	const text = String(value || "").trim().toLowerCase();
	if (/^(high|urgent|1|p1|critical|asap|must)/.test(text)) return "high";
	if (/^(low|3|p3|someday|nice|maybe)/.test(text)) return "low";
	return "normal";
}

/**
 * Read a pasted sheet without writing anything.
 * Returns what would be created, so the person can look before it lands.
 */
function preview(text) {
	const rows = parseDelimited(text);
	if (!rows.length) throw bad("There were no rows in that.");
	let mapping = mapHeaders(rows[0]);
	const hadHeader = looksLikeHeader(mapping, rows[0]);
	const body = hadHeader ? rows.slice(1) : rows;
	if (!hadHeader) mapping = rows[0].map((_, i) => (i === 0 ? "title" : null));
	if (!mapping.includes("title")) mapping[0] = "title";
	if (body.length > MAX_ROWS) throw bad(`That is ${body.length} rows — import up to ${MAX_ROWS} at a time.`);

	const projects = [];
	const skipped = [];
	body.forEach((cells, index) => {
		const raw = {};
		mapping.forEach((field, column) => {
			if (!field) return;
			const value = String(cells[column] ?? "").trim();
			if (value) raw[field] = value;
		});
		if (!raw.title) {
			skipped.push({ line: index + 1, reason: "no title in that row" });
			return;
		}
		const project = {
			title: raw.title,
			detail: raw.detail,
			area: raw.area,
			status: statusFrom(raw.status),
			priority: priorityFrom(raw.priority),
			effortMinutes: raw.effortMinutes === undefined ? null : effortToMinutes(raw.effortMinutes),
			indoor: raw.indoor === undefined ? null : TRUE.test(raw.indoor) ? true : FALSE.test(raw.indoor) ? false : null,
			costEstimate: raw.costEstimate ?? null,
			dueDate: raw.dueDate ?? null,
			blockedOn: raw.blockedOn,
		};
		try {
			homeProjects.normalize(project);
			projects.push(project);
		} catch (err) {
			skipped.push({ line: index + 1, reason: err.message });
		}
	});
	// Columns we could not place, named back to the person. Only meaningful
	// when there was a header row to name them with.
	const unmapped = hadHeader
		? rows[0].map((cell, i) => (mapping[i] ? null : String(cell || "").trim())).filter(Boolean)
		: [];
	return { projects, skipped, columns: mapping.filter(Boolean), unmapped };
}

/**
 * Write a previewed import. Existing projects are left alone — re-importing a
 * sheet adds rows, it does not reconcile them, and the person is told the
 * count so a double paste is visible rather than mysterious.
 */
async function importText(profileId, text) {
	const result = preview(text);
	const created = [];
	for (const project of result.projects) {
		try {
			created.push(await homeProjects.create(profileId, project, { source: "import" }));
		} catch (err) {
			result.skipped.push({ line: null, reason: err.message });
		}
	}
	return { ...result, created: created.length, projects: created };
}

module.exports = { parseDelimited, preview, importText, effortToMinutes, statusFrom, priorityFrom, MAX_ROWS };
