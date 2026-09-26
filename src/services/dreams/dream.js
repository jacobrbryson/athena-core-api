/**
 * Dreaming — the nightly pass where Athena reorganizes what she remembers.
 *
 * Facts arrive loosely ("sister" = "Emma — moved to Denver in August"). While
 * dreaming she looks at them against the tables she has already built in
 * athena_mind and decides, in her own SQL, what structure would make them
 * easier to use: a people table, a places table, a view joining them, a merge
 * of two rows that are the same person. Anything she can't settle she turns
 * into a question for the person instead of a guess.
 *
 * Shape of a night (every step lands in athena_dream_step):
 *
 *   mirror   rewrite _fact / _clarification from the main database
 *   purge    delete rows whose facts were forgotten since last night
 *   rounds   up to N model rounds; each proposes steps, the code runs them on
 *            her connection and shows her the results in the next round
 *   guard    drop tables that break the rules, purge again, tidy the catalog
 *
 * See mind.js for why she is allowed to run arbitrary DDL there at all.
 */
const { v4: uuidv4 } = require("uuid");
const pool = require("../../helpers/db");
const llm = require("../llm");
const { audienceForProfile } = require("../audience");
const mind = require("./mind");
const questions = require("./questions");
const { redactStep } = require("./redact");
const image = require("./image");

const DEFAULT_ROUNDS = Number(process.env.ATHENA_DREAM_ROUNDS) || 6;
const MAX_STEPS_PER_ROUND = 30;
const FOCUS_FACTS = 150;
const AUDIT_DAYS = 30;

const STEP_SCHEMA = {
	type: "object",
	properties: {
		op: { type: "string", enum: ["sql", "upsert", "describe", "question", "answer"] },
		why: { type: "string" },
		statement: { type: "string" },
		table: { type: "string" },
		rows_json: { type: "string" },
		object: { type: "string" },
		// Not "description": a property by that name vanished from Gemini's
		// output every time (it collides with the schema keyword), which left
		// every describe step empty for a whole night.
		purpose: { type: "string" },
		label_column: { type: "string" },
		// Capped: Flash-Lite has been seen looping on this list until the
		// output never closed ("panting", "gasping", … for 180 KB).
		triggers: { type: "array", items: { type: "string" }, maxItems: 12 },
		profile_id: { type: "integer" },
		question: { type: "string" },
		about: { type: "array", items: { type: "string" }, maxItems: 12 },
		question_id: { type: "integer" },
		status: { type: "string", enum: ["answered", "dismissed"] },
		answer: { type: "string" },
	},
	required: ["op", "why"],
};

const ROUND_SCHEMA = {
	type: "object",
	properties: {
		thinking: { type: "string" },
		// No maxItems here: Gemini 400s on it for an array of objects (the
		// string-list caps above are fine). The code slices to the cap instead.
		steps: { type: "array", items: STEP_SCHEMA },
		done: { type: "boolean" },
		summary: { type: "string" },
	},
	required: ["steps", "done", "summary"],
};

const NARRATIVE_SCHEMA = {
	type: "object",
	properties: { narrative: { type: "string" } },
	required: ["narrative"],
};

/**
 * Dreaming runs on ChatGPT (the owner's choice, 2026-09-26: the chat-tuned
 * models were a poor fit for schema design). Task "dream" is served only by an
 * endpoint that declares a dream model (OPENAI_DREAM_MODEL). When none is
 * configured, or it fails, the night falls back to the "review" chain —
 * also the owner's choice — and the returned `fellBack` lets the log say so.
 */
async function think(opts) {
	const hasDreamer = llm.endpointsFor("dream").length > 0;
	if (hasDreamer) {
		try {
			return { ...(await llm.generateJson({ ...opts, task: "dream" })), fellBack: null };
		} catch (err) {
			const res = await llm.generateJson({ ...opts, task: "review" });
			return { ...res, fellBack: String(err.message).slice(0, 300) };
		}
	}
	return { ...(await llm.generateJson({ ...opts, task: "review" })), fellBack: null };
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

async function openDream() {
	const uuid = uuidv4();
	const date = new Date().toLocaleDateString("en-CA", { timeZone: process.env.ATHENA_TZ || "America/New_York" });
	const [res] = await pool.query(`INSERT INTO athena_dream (uuid, dream_date) VALUES (?, ?)`, [uuid, date]);
	return { id: res.insertId, uuid, date };
}

function recorder(dreamId) {
	let seq = 0;
	const digest = [];
	async function record(kind, { round = 0, statement = null, why = null, ok = true, error = null, affectedRows = null, ms = null } = {}) {
		seq += 1;
		const safe = redactStep({ kind, statement, error });
		digest.push(
			`${kind}${ok ? "" : " FAILED"}${affectedRows != null ? ` (${affectedRows})` : ""}: ${String(safe.statement || why || "").replace(/\s+/g, " ").slice(0, 240)}${safe.error ? ` — error: ${String(safe.error).slice(0, 120)}` : ""}`
		);
		await pool
			.query(
				`INSERT INTO athena_dream_step (dream_id, seq, round, kind, statement, why, ok, error, affected_rows, ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					dreamId,
					seq,
					round,
					kind,
					statement == null ? null : String(statement).slice(0, 60000),
					why == null ? null : String(why).slice(0, 2000),
					ok ? 1 : 0,
					error == null ? null : String(error).slice(0, 500),
					affectedRows,
					ms,
				]
			)
			.catch((err) => console.warn("[dream] could not record step:", err.message));
	}
	record.digest = digest;
	return record;
}

async function closeDream(id, { status, summary, narrative = null, imagePath = null, imageModel = null, servedBy, stats }) {
	await pool.query(
		`UPDATE athena_dream SET status = ?, summary = ?, narrative = ?, image_path = ?, image_model = ?, served_by = ?, stats = ?, finished_at = NOW() WHERE id = ?`,
		[
			status,
			summary ? String(summary).slice(0, 4000) : null,
			narrative ? String(narrative).slice(0, 6000) : null,
			imagePath,
			imageModel ? String(imageModel).slice(0, 80) : null,
			servedBy ? String(servedBy).slice(0, 80) : null,
			JSON.stringify(stats || {}),
			id,
		]
	);
}

/**
 * The same night, told the way a person tells a dream over breakfast — but
 * made of what actually happened. It only ever sees the redacted digest (no
 * values, no question text), so it can't leak what the facts say, and it is
 * told not to invent events that aren't in it: whimsy in the telling, not in
 * the record. A night the model can't narrate simply has no narrative.
 */
async function narrate({ summary, digest, stats, status }) {
	const prompt = `You are Athena. Last night you dreamed — which for you means you spent the night reorganizing your memories in your own database. Below is the real log of that night (values redacted) and your plain summary of it.

Tell last night as a DREAM — the way a person recounts a vivid, strange dream over breakfast: first person, past tense, 120–200 words, one to three short paragraphs. It should read like a real dream, not a report.

- Let what really happened become dream imagery, without naming it: new tables are rooms or cabinets that appear, new columns are new kinds of labels, merging duplicates is two keys melting into one, nicknames are doors with two names on them, views are windows or balconies that show several rooms at once, a purge is a tide carrying off what someone asked you to forget, a failed step is a door that wouldn't open, a question you're holding is a sealed letter you'll deliver in the morning. Invent your own images freely — dreams shift and blur.
- No technical words at all: no table or view names, no SQL, no code formatting or backticks, no row counts. The Dreams log keeps the technical record; this is the dream.
- Be faithful in shape: the dream's events should follow the log's real events (building, tidying, merging, failing, asking, forgetting), in roughly that order. Don't dream of things that didn't happen. A quiet night is a quiet dream.
- No personal details — no names of people, places, pets or anything remembered, and never the text of a question. The household reads this.
- Warm, whimsical, a little uncanny; never frightening. End as you wake.

Status: ${status}. Counts: ${JSON.stringify(stats)}.

Summary: ${String(summary || "(none)").slice(0, 1500)}

Log:
${digest.slice(0, 160).join("\n").slice(0, 14000)}

Return JSON: {"narrative": "..."}`;
	try {
		const { data } = await think({
			audience: "adult",
			schema: NARRATIVE_SCHEMA,
			temperature: 0.9,
			contents: prompt,
			check: (d) => (typeof d?.narrative === "string" && d.narrative.trim().length > 40 ? null : "missing narrative"),
		});
		return data.narrative.trim();
	} catch {
		return null;
	}
}

/** Thirty days of dreams, then they go. Steps follow by cascade. */
async function pruneAudit(days = AUDIT_DAYS) {
	const [res] = await pool.query(`DELETE FROM athena_dream WHERE started_at < DATE_SUB(NOW(), INTERVAL ? DAY)`, [days]);
	return res.affectedRows || 0;
}

// ---------------------------------------------------------------------------
// What she dreams about
// ---------------------------------------------------------------------------

/**
 * Adults only. A child's memories never reach athena_mind — the extractor
 * already refuses to keep other people's names from a child's conversation,
 * and a table of people is exactly what that rule exists to prevent.
 */
async function adultProfiles() {
	const [rows] = await pool.query(`SELECT DISTINCT profile_id FROM user_memory WHERE deleted_at IS NULL`);
	const adults = [];
	for (const r of rows) {
		if ((await audienceForProfile(r.profile_id).catch(() => "child")) === "adult") adults.push(Number(r.profile_id));
	}
	return adults;
}

async function loadFacts(profileIds) {
	if (!profileIds.length) return [];
	const [rows] = await pool.query(
		`SELECT id, profile_id, category, memory_key, memory_value, updated_at FROM user_memory
     WHERE deleted_at IS NULL AND profile_id IN (?) ORDER BY profile_id, id`,
		[profileIds]
	);
	return rows.map((r) => ({ ...r, id: Number(r.id), profile_id: Number(r.profile_id) }));
}

async function profileNames(profileIds) {
	if (!profileIds.length) return new Map();
	const [rows] = await pool.query(`SELECT id, full_name FROM profile WHERE id IN (?)`, [profileIds]);
	return new Map(rows.map((r) => [Number(r.id), String(r.full_name || "").split(/\s+/)[0] || `profile ${r.id}`]));
}

async function lastDream() {
	const [[row]] = await pool.query(
		`SELECT started_at, summary FROM athena_dream WHERE status IN ('ok', 'partial') ORDER BY started_at DESC LIMIT 1`
	);
	return row || null;
}

async function pendingNotOffered() {
	const [rows] = await pool.query(
		`SELECT id, profile_id, question FROM athena_dream_question
     WHERE status = 'pending' AND offered_session_id IS NULL AND expires_at > NOW()`
	);
	return rows;
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

function iso(d) {
	if (!d) return "";
	return (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
}

function renderSchema(entries, catalog) {
	const notes = new Map(catalog.map((c) => [c.object_name, c]));
	const lines = [];
	for (const e of entries) {
		const cols = e.columns.map((c) => `${c.name} ${c.type}${c.key === "PRI" ? " PK" : ""}`).join(", ");
		const note = notes.get(e.name);
		lines.push(
			`- ${e.kind} \`${e.name}\` (${e.rows ?? "?"} rows${e.error ? `, ERROR: ${e.error}` : ""}): ${cols}` +
				(note ? `\n    catalog: ${note.description}${note.label_column ? ` [label: ${note.label_column}]` : ""}` : "") +
				(e.definition ? `\n    AS ${e.definition}` : "")
		);
	}
	return lines.join("\n") || "(empty — you have not built anything yet)";
}

function renderFacts(facts) {
	return facts
		.map((f) => {
			const value = String(f.memory_value || "").replace(/\s+/g, " ").slice(0, 300);
			return `f:${f.id} p${f.profile_id} [${f.category}] ${f.memory_key}: ${value} (updated ${iso(f.updated_at)})`;
		})
		.join("\n");
}

function renderResults(history) {
	if (!history.length) return "(this is the first round)";
	return history
		.map((h) => {
			const head = `round ${h.round} #${h.index} ${h.op}${h.ok ? " ok" : " FAILED"}`;
			const body = h.ok ? JSON.stringify(h.result ?? {}).slice(0, 1500) : h.error;
			return `${head}: ${body}`;
		})
		.join("\n")
		.slice(-12000);
}

function buildPrompt({ round, maxRounds, people, schema, focus, factCounts, offered, waiting, last, history }) {
	return `You are Athena, and it is night: you are dreaming. Dreaming is when you take what you've remembered loosely during the day and give it structure, so that tomorrow you can answer "who do I know in Denver?" or "list the people I've told you about" from a table instead of a pile of notes.

You have your own MySQL 8 database, athena_mind, and full control of it: CREATE / ALTER / DROP tables and views, INSERT / UPDATE / DELETE, and SELECT to look around. Design it the way a thoughtful data architect would: entities in their own tables (people, places, organizations, pets…), relationships in join tables, aliases so "my sister" and "Emma" resolve to one person, views that make common questions one query. Evolve it: when a structure turns out wrong, migrate it. Prefer a few well-shaped tables over many thin ones.

## Rules the code enforces (breaking them only costs you work)
1. Every TABLE you create must have \`_profile_id BIGINT NOT NULL\` (whose memory this row came from) and \`_sources JSON NOT NULL\` (array like ["f:123","q:4"] — the facts or answered questions the row was built from). After every dream, rows whose sources no longer exist for that same _profile_id are deleted (that is how "forget that" reaches you) and tables missing either column are dropped.
2. Never mix people's memories in a row: every source in a row must belong to that row's _profile_id. Joins across tables must match on _profile_id.
3. Tables starting with _ belong to the code. Read them, never write them:
   - _fact(fact_id, profile_id, category, fact_key, fact_value, updated_at) — every current fact, the source of truth.
   - _clarification(question_id, profile_id, question, answer, answered_at) — answers people gave to your questions.
   - _catalog — written only through the "describe" op.
4. Views are welcome. Give views a _profile_id column too, or the chat can't read them.
5. One SQL statement per "sql" step, no trailing semicolons chains. Stored procedures, triggers and events are not permitted.
6. Only record what the facts say. Don't invent details. If two facts might be the same person/place and you can't tell, ASK instead of merging.

## Ops (the "steps" array; each needs a short "why")
- {"op":"sql","statement":"..."} — any single statement. SELECT results come back next round.
Each op uses ONLY its own fields:
- {"op":"upsert","table":"people","rows_json":"[{\\"_profile_id\\":7,\\"_sources\\":[\\"f:12\\"],\\"name\\":\\"Emma\\"}]"} — code-parameterized INSERT … ON DUPLICATE KEY UPDATE; the safest way to put extracted values into a table. Rows with sources that aren't that person's are rejected.
- {"op":"describe","object":"people","purpose":"everyone the person has told me about","label_column":"name","triggers":["people","friends","family","who"]} — "purpose" is REQUIRED (one sentence, no personal details); triggers are everyday words a person would say, never column names. Tells your daytime self what a table/view is for; label_column is the name-like column chat matches against the message, triggers are words that make it relevant. Describe every table/view you want to use in conversation.
- {"op":"question","profile_id":7,"question":"...","about":["f:12","f:30"]} — something only the person can settle. Warm, short, one thing at a time, phrased to them ("Is the Emma who moved to Denver your sister?"). Don't ask what the facts already answer, and don't re-ask a waiting question.
- {"op":"answer","question_id":3,"status":"answered","answer":"Yes — the same Emma."} — record what the person said to a question you asked (see transcripts below). Use "dismissed" if they declined or it no longer matters. Only when the transcript actually shows an answer or a refusal; otherwise leave it.

## Whose memories
${people.map((p) => `- p${p.id} = ${p.name}`).join("\n") || "(nobody)"}

## Your database right now
${schema}

## Facts to organize tonight (${focus.length} of ${factCounts.total}; ${factCounts.unorganized} not yet in any table, ${factCounts.changed} changed since your last dream)
${renderFacts(focus) || "(nothing new — use tonight to improve the structure, or finish early)"}

## Questions you asked — what was said since
${
	offered.length
		? offered
				.map(
					(q) =>
						`- question_id ${q.id} (p${q.profile_id}): "${q.question}"\n${(q.transcript || []).map((t) => `    ${t}`).join("\n") || "    (nothing said yet)"}`
				)
				.join("\n")
		: "(none)"
}

## Questions still waiting to be asked (don't duplicate)
${waiting.map((q) => `- p${q.profile_id}: "${q.question}"`).join("\n") || "(none)"}

## Last dream
${last?.summary ? String(last.summary).slice(0, 1200) : "(this is your first dream)"}

## Results so far tonight
${renderResults(history)}

This is round ${round} of at most ${maxRounds}. Return JSON: {"thinking": brief, "steps": [...], "done": true when the night's work is finished, "summary": the Dreams log entry for the whole night so far — first person, what you noticed and changed, table names and counts only, NO personal details (no names, places or values: this log may be read by anyone in the household)}. Keep each round to at most ${MAX_STEPS_PER_ROUND} steps. If a step failed, fix it or route around it rather than repeating it. Keep every "why" free of personal details too — the reasons are shown in the Dreams log.`;
}

// ---------------------------------------------------------------------------
// Running her steps
// ---------------------------------------------------------------------------

async function runStep(step, ctx) {
	switch (step.op) {
		case "sql":
			return mind.runStatement(ctx.conn, step.statement);
		case "upsert": {
			let rows;
			try {
				rows = JSON.parse(step.rows_json || "[]");
			} catch {
				throw new Error("rows_json is not valid JSON");
			}
			// The schema is flat, so a model sometimes names the table in
			// `object` (the describe field). Same meaning; accept either.
			return mind.upsertRows(ctx.conn, step.table || step.object, rows, ctx);
		}
		case "describe":
			return mind.describeObject(ctx.conn, { ...step, object: step.object || step.table, description: step.purpose || step.description });
		case "question": {
			const pid = Number(step.profile_id);
			if (!ctx.adults.includes(pid)) throw new Error(`p${step.profile_id} is not someone whose memories you hold`);
			const about = (step.about || []).filter((s) => /^[fq]:\d+$/.test(s)).slice(0, 20);
			const q = await questions.create({ profileId: pid, dreamId: ctx.dreamId, question: step.question, context: { about } });
			ctx.questionsAsked += 1;
			return q;
		}
		case "answer": {
			const q = ctx.offered.find((o) => Number(o.id) === Number(step.question_id));
			if (!q) throw new Error(`question ${step.question_id} is not one you asked and are waiting on`);
			const res = await questions.resolve(q.id, { status: step.status || "answered", answer: step.answer });
			if ((step.status || "answered") === "answered") {
				// Usable as a q: source tonight, not only after the next mirror.
				await ctx.conn.query(
					`INSERT INTO _clarification (question_id, profile_id, question, answer, answered_at) VALUES (?, ?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE answer = VALUES(answer), answered_at = VALUES(answered_at)`,
					[q.id, q.profile_id, q.question, step.answer || null]
				);
				ctx.clarificationOwner.set(Number(q.id), Number(q.profile_id));
			}
			ctx.questionsResolved += 1;
			return res;
		}
		default:
			throw new Error(`unknown op ${step.op}`);
	}
}

function statementFor(step) {
	switch (step.op) {
		case "sql":
			return step.statement;
		case "upsert":
			return `UPSERT ${step.table || step.object} ${step.rows_json}`;
		case "describe":
			return `DESCRIBE ${step.object || step.table}: ${step.purpose || step.description}${step.label_column ? ` [label ${step.label_column}]` : ""} triggers=${JSON.stringify(step.triggers || [])}`;
		case "question":
			return `ASK p${step.profile_id}: ${step.question}`;
		case "answer":
			return `ANSWER question ${step.question_id} (${step.status || "answered"}): ${step.answer || ""}`;
		default:
			return JSON.stringify(step);
	}
}

// ---------------------------------------------------------------------------
// A night
// ---------------------------------------------------------------------------

async function dream({ rounds = DEFAULT_ROUNDS, log = () => undefined } = {}) {
	const night = await openDream();
	const record = recorder(night.id);
	const stats = { facts: 0, focus: 0, rounds: 0, steps_ok: 0, steps_failed: 0, purged: 0, guard_drops: 0, questions_asked: 0, questions_resolved: 0 };

	if (!mind.configured()) {
		await record("note", { why: "athena_mind is not configured (ATHENA_MIND_DB_USER / ATHENA_MIND_DB_PASS); nothing to do", ok: false });
		await closeDream(night.id, { status: "skipped", summary: "I couldn't dream — my own database isn't set up yet.", stats });
		return { status: "skipped", uuid: night.uuid };
	}

	let conn;
	let servedBy = null;
	let summary = null;
	try {
		conn = await mind.connect();
		await mind.ensureSystemTables(conn);

		// 1. Mirror the facts in.
		const adults = await adultProfiles();
		const facts = await loadFacts(adults);
		const answered = await questions.answeredFor(adults);
		const started = Date.now();
		const mirrored = await mind.refreshMirror(conn, { facts, clarifications: answered });
		await record("mirror", { statement: `_fact <- ${mirrored.facts} facts; _clarification <- ${mirrored.clarifications} answers`, why: "facts are the source of truth", ms: Date.now() - started, affectedRows: mirrored.facts });
		stats.facts = facts.length;

		// 2. Forget first, so tonight never builds on something already let go.
		for (const p of await mind.purge(conn)) {
			stats.purged += p.deleted || 0;
			await record("purge", { statement: p.statement, why: `rows whose sources are gone (${p.table})`, ok: p.ok, error: p.error, affectedRows: p.deleted ?? null });
		}

		// 3. What's worth her attention tonight.
		const last = await lastDream();
		const entries = await mind.describe(conn);
		const referenced = await mind.referencedSources(conn, entries);
		const since = last?.started_at ? new Date(last.started_at) : null;
		const unorganized = facts.filter((f) => !referenced.has(`f:${f.id}`));
		const changed = facts.filter((f) => referenced.has(`f:${f.id}`) && since && f.updated_at && new Date(f.updated_at) > since);
		const focus = [...changed, ...unorganized].slice(0, FOCUS_FACTS);
		stats.focus = focus.length;

		const names = await profileNames(adults);
		const ctx = {
			conn,
			dreamId: night.id,
			adults,
			factOwner: new Map(facts.map((f) => [f.id, f.profile_id])),
			clarificationOwner: new Map(answered.map((a) => [Number(a.id), Number(a.profile_id)])),
			offered: await questions.offeredWithTranscripts(),
			questionsAsked: 0,
			questionsResolved: 0,
		};
		const waiting = await pendingNotOffered();

		// 4. The dream proper.
		const history = [];
		for (let round = 1; round <= rounds; round += 1) {
			const [catalog] = await conn.query("SELECT object_name, description, label_column FROM _catalog");
			const prompt = buildPrompt({
				round,
				maxRounds: rounds,
				people: adults.map((id) => ({ id, name: names.get(id) || `profile ${id}` })),
				schema: renderSchema(await mind.describe(conn), catalog),
				focus,
				factCounts: { total: facts.length, unorganized: unorganized.length, changed: changed.length },
				offered: ctx.offered,
				waiting,
				last,
				history,
			});
			// Two tries per round: a model that loops or truncates once usually
			// doesn't the second time, and losing the whole night to one bad
			// sample is worse than the extra call.
			let data;
			for (let attempt = 1; attempt <= 2 && !data; attempt += 1) {
				try {
					const res = await think({
						audience: "adult",
						schema: ROUND_SCHEMA,
						temperature: 0.2,
						contents: prompt,
						check: (d) => (Array.isArray(d?.steps) && typeof d?.summary === "string" ? null : "missing steps/summary"),
					});
					data = res.data;
					servedBy = `${res.model || res.endpointId} (${res.endpointId})`;
					if (res.fellBack) await record("note", { round, why: `ChatGPT couldn't dream this round, so ${res.endpointId} stood in: ${res.fellBack}`, ok: false });
				} catch (err) {
					await record("note", { round, why: `no model could dream this round (attempt ${attempt}): ${String(err.message).slice(0, 400)}`, ok: false });
				}
			}
			if (!data) break;
			stats.rounds = round;
			if (data.summary) summary = data.summary;
			if (data.thinking) await record("note", { round, why: String(data.thinking).slice(0, 2000) });

			const steps = data.steps.slice(0, MAX_STEPS_PER_ROUND);
			for (let i = 0; i < steps.length; i += 1) {
				const step = steps[i];
				const t0 = Date.now();
				try {
					const result = await runStep(step, ctx);
					stats.steps_ok += 1;
					history.push({ round, index: i + 1, op: step.op, ok: true, result });
					await record(step.op, {
						round,
						statement: statementFor(step),
						why: step.why,
						ms: Date.now() - t0,
						affectedRows: result?.affectedRows ?? result?.total ?? null,
						error: result?.rejected?.length ? `rejected ${result.rejected.length} row(s): ${[...new Set(result.rejected)].join("; ")}` : null,
					});
				} catch (err) {
					stats.steps_failed += 1;
					history.push({ round, index: i + 1, op: step.op, ok: false, error: String(err.message).slice(0, 300) });
					await record(step.op, { round, statement: statementFor(step), why: step.why, ok: false, error: err.message, ms: Date.now() - t0 });
				}
			}
			// "Done" doesn't count while something failed this round: she is
			// told to fix or route around failures, and gets the round to do it.
			const failedThisRound = history.some((h) => h.round === round && !h.ok);
			log(`round ${round}: ${steps.length} step(s)${data.done ? ", done" : ""}${failedThisRound ? ", with failures" : ""}`);
			if ((data.done && !failedThisRound) || !steps.length) break;
		}
		stats.questions_asked = ctx.questionsAsked;
		stats.questions_resolved = ctx.questionsResolved;

		// 5. Hold her to the rules, whatever the night did.
		for (const g of await mind.guard(conn)) {
			stats.guard_drops += 1;
			await record("guard", { statement: g.statement, why: g.why, ok: g.ok, error: g.error });
		}
		for (const p of await mind.purge(conn)) {
			stats.purged += p.deleted || 0;
			await record("purge", { statement: p.statement, why: `rows whose sources are gone (${p.table})`, ok: p.ok, error: p.error, affectedRows: p.deleted ?? null });
		}
		const tidied = await mind.pruneCatalog(conn);
		if (tidied) await record("guard", { statement: "DELETE FROM _catalog WHERE object is gone", why: "catalog entries for dropped objects", affectedRows: tidied });

		const status = stats.rounds === 0 ? "failed" : stats.steps_failed ? "partial" : "ok";
		const finalSummary = summary || "I looked things over and left them as they were.";
		const narrative = stats.rounds ? await narrate({ summary: finalSummary, digest: record.digest, stats, status }) : null;

		// A picture of it, painted from the narrative alone (see image.js).
		// A failure costs the picture, never the night.
		let picture = null;
		if (narrative) {
			const t0 = Date.now();
			try {
				picture = await image.paint(night, narrative);
				await record("image", { statement: `${picture.path} (${picture.model})`, why: "a picture of the dream", ms: Date.now() - t0 });
			} catch (err) {
				await record("image", { why: "a picture of the dream", ok: false, error: err.message, ms: Date.now() - t0 });
			}
		}
		await closeDream(night.id, { status, summary: finalSummary, narrative, imagePath: picture?.path, imageModel: picture?.model, servedBy, stats });
		return { status, uuid: night.uuid, stats };
	} catch (err) {
		await record("note", { why: `the dream stopped: ${err.message}`, ok: false });
		await closeDream(night.id, { status: "failed", summary, servedBy, stats }).catch(() => undefined);
		throw err;
	} finally {
		if (conn) await conn.end().catch(() => undefined);
	}
}

module.exports = { dream, pruneAudit, narrate, buildPrompt, runStep, ROUND_SCHEMA, AUDIT_DAYS };
