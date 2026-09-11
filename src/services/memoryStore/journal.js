/**
 * The human-readable side of memory.
 *
 *   renderJournal()  — Markdown of everything Athena remembers about a person:
 *                      facts by category, recent moments, her reflections.
 *                      Shown in the Companion app and exportable, so memory is
 *                      never a black box.
 *   reflectOnDay()   — nightly: Athena reads a day's episodes and writes a
 *                      short reflection (kind "reflection"), the compressed
 *                      layer that keeps a year of memories recallable.
 */
const pool = require("../../helpers/db");
const llm = require("../llm");
const { createEvent, publicEvent } = require("./events");

const CATEGORY_TITLES = {
	person: "People",
	family: "Family",
	pet: "Pets",
	place: "Places",
	work: "Work & school",
	interest: "Interests",
	subject: "Favorite subjects",
	goal: "Goals",
	routine: "Routines",
	preference: "Preferences",
	other: "Other",
};

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function renderJournal(profileId, { displayName, eventLimit = 40 } = {}) {
	const [facts] = await pool.query(
		`SELECT category, memory_key, memory_value, source, updated_at FROM user_memory
     WHERE profile_id = ? AND deleted_at IS NULL ORDER BY category, updated_at DESC;`,
		[profileId]
	);
	const [events] = await pool.query(
		`SELECT * FROM memory_event WHERE profile_id = ? AND deleted_at IS NULL AND kind <> 'reflection'
     ORDER BY occurred_at DESC LIMIT ?;`,
		[profileId, eventLimit]
	);
	const [reflections] = await pool.query(
		`SELECT * FROM memory_event WHERE profile_id = ? AND deleted_at IS NULL AND kind = 'reflection'
     ORDER BY occurred_at DESC LIMIT 14;`,
		[profileId]
	);

	const out = [`# What Athena remembers${displayName ? ` about ${displayName}` : ""}`, ""];
	out.push(`_Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. Anything here can be deleted from the Memories panel._`, "");

	const byCategory = new Map();
	for (const f of facts) {
		if (!byCategory.has(f.category)) byCategory.set(f.category, []);
		byCategory.get(f.category).push(f);
	}
	out.push("## Things I know", "");
	if (!facts.length) out.push("_Nothing yet._", "");
	for (const [cat, rows] of byCategory) {
		out.push(`### ${CATEGORY_TITLES[cat] || cat}`);
		for (const f of rows) {
			const src = f.source === "ai" ? " _(picked up in conversation)_" : "";
			out.push(`- **${oneLine(f.memory_key)}**${f.memory_value ? ` — ${oneLine(f.memory_value)}` : ""}${src}`);
		}
		out.push("");
	}

	out.push("## Moments", "");
	if (!events.length) out.push("_Nothing yet._", "");
	for (const e of events.map(publicEvent)) {
		out.push(`- **${day(e.occurred_at)}** · ${e.kind}${e.title ? ` · ${oneLine(e.title)}` : ""}  `);
		out.push(`  ${oneLine(e.content).slice(0, 400)}`);
	}
	out.push("");

	if (reflections.length) {
		out.push("## Athena's reflections", "");
		for (const r of reflections) out.push(`- **${day(r.occurred_at)}** — ${oneLine(r.content)}`);
		out.push("");
	}
	return out.join("\n");
}

const REFLECTION_SCHEMA = {
	type: "object",
	properties: {
		reflection: { type: "string" },
		importance: { type: "number" },
	},
	required: ["reflection", "importance"],
};

/**
 * Write one reflection for a profile's episodes in [from, to). Returns the
 * event, or null when the day was too quiet to reflect on.
 */
async function reflectOnDay(profileId, { from, to, audience = "adult" }) {
	const [rows] = await pool.query(
		`SELECT kind, title, content, occurred_at FROM memory_event
     WHERE profile_id = ? AND deleted_at IS NULL AND kind <> 'reflection'
       AND occurred_at >= ? AND occurred_at < ?
     ORDER BY occurred_at ASC LIMIT 40;`,
		[profileId, from, to]
	);
	if (rows.length < 2) return null;

	const lines = rows.map((r) => `- [${r.kind}] ${r.title ? `${oneLine(r.title)}: ` : ""}${oneLine(r.content).slice(0, 300)}`);
	const { data } = await llm.generateJson({
		task: "extract",
		audience,
		schema: REFLECTION_SCHEMA,
		contents: `You are Athena, writing a private note in your own memory at the end of the day about the person you spend time with.
Summarize what mattered today in 2-4 sentences, in first person ("We talked about…", "They showed me…"). Keep concrete details (names, places, plans) that would help you remember later. No flattery, no filler.
importance 1-10: how much of this is worth keeping for months.
${audience === "adult" ? "" : "This person is a child: keep it to interests, activities, and things they enjoyed — no names of other people, places, or personal details."}
Return ONLY JSON matching: ${JSON.stringify(REFLECTION_SCHEMA)}

Today's memories:
${lines.join("\n")}`,
		check: (d) => (typeof d?.reflection === "string" && d.reflection.trim() ? null : "no reflection"),
	});

	return createEvent({
		profileId,
		kind: "reflection",
		title: `Reflection · ${day(from)}`,
		content: data.reflection,
		occurredAt: new Date(new Date(to).getTime() - 1000),
		importance: data.importance,
		source: "ai",
		visibility: "private",
	});
}

/** Profiles with at least two new episodes in the window. */
async function profilesNeedingReflection(from, to) {
	const [rows] = await pool.query(
		`SELECT profile_id FROM memory_event
     WHERE profile_id IS NOT NULL AND deleted_at IS NULL AND kind <> 'reflection'
       AND occurred_at >= ? AND occurred_at < ?
     GROUP BY profile_id HAVING COUNT(*) >= 2;`,
		[from, to]
	);
	return rows.map((r) => Number(r.profile_id));
}

module.exports = { renderJournal, reflectOnDay, profilesNeedingReflection };
