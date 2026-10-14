/**
 * Seed projects from a reviewed import file (the format of
 * project-import/home/home-import.json at the workspace root — see
 * docs/architecture/projects.md, "Migration from what exists").
 *
 * A one-time seed. After it runs the Companion app is the source of truth, so a
 * re-run only CREATES rows whose import key is missing: it never overwrites a
 * project, concern or charter that already exists, never re-adds a link the
 * owner removed (links and steps are only written for projects created in this
 * run), and never deletes. `overwrite` exists for a botched first run: it
 * deletes the rows carrying this file's keys first, then creates them fresh.
 *
 * Refuses to write while the file still carries any "review" question.
 */
const projects = require("./index");
const shape = require("./shape");

const { bad } = shape;

function reviews(file) {
	const out = [];
	if (file.charter?.review) out.push(`charter: ${file.charter.review}`);
	for (const c of file.concerns || []) if (c.review) out.push(`${c.key}: ${c.review}`);
	for (const p of file.projects || []) if (p.review) out.push(`${p.key}: ${p.review}`);
	return out;
}

const pair = (range) => (Array.isArray(range) ? [range[0] ?? null, range[1] ?? range[0] ?? null] : [null, null]);

/** One file project → the input services/projects create() reads. */
function toInput(p, area) {
	const [diyLow, diyHigh] = pair(p.cost?.diy);
	const [proLow, proHigh] = pair(p.cost?.pro);
	return {
		title: p.title,
		goal: p.goal ?? null,
		kind: p.kind ?? null,
		status: p.status ?? "idea",
		waitingOn: p.waiting_on ?? null,
		priority: p.priority ?? 3,
		hardDeadline: p.hard_deadline ?? null,
		effort: { min: p.effort?.min ?? null, max: p.effort?.max ?? null, note: p.effort?.note ?? null },
		indoor: p.indoor ?? null,
		cost: { diyLow, diyHigh, proLow, proHigh, note: p.cost?.note ?? null },
		valueNote: p.value_note ?? null,
		seasonMonths: p.months ?? null,
		conditions: p.conditions ?? [],
		serves: p.serves ?? [],
		areas: p.areas ?? [area],
		primaryArea: p.primary_area ?? area,
		completedAt: p.completed ?? null,
	};
}

function validate(file) {
	if (!file || typeof file !== "object") throw bad("The import file is not an object.");
	const area = shape.read.pick(file.area, shape.AREAS, undefined, "File area");
	const keys = new Set();
	const problems = [];
	for (const p of file.projects || []) {
		if (!p.key) problems.push(`a project without a key: ${p.title}`);
		if (keys.has(p.key)) problems.push(`duplicate key ${p.key}`);
		keys.add(p.key);
		try {
			shape.normalizeProject(toInput(p, area));
			shape.normalizeAreas(toInput(p, area));
			for (const s of p.steps || []) shape.normalizeStep(s);
		} catch (err) {
			problems.push(`${p.key}: ${err.message}`);
		}
	}
	for (const p of file.projects || []) {
		for (const k of p.contributes_to || []) if (!keys.has(k)) problems.push(`${p.key} is part of unknown ${k}`);
		for (const d of p.depends_on || []) if (!keys.has(d.key)) problems.push(`${p.key} needs unknown ${d.key}`);
	}
	for (const c of file.concerns || []) {
		try { shape.normalizeConcern({ ...c, area }); } catch (err) { problems.push(`${c.key}: ${err.message}`); }
		for (const k of c.projects || []) if (!keys.has(k)) problems.push(`${c.key} links unknown ${k}`);
	}
	if (file.charter) {
		try { shape.normalizeCharter(file.charter); } catch (err) { problems.push(`charter: ${err.message}`); }
	}
	if (problems.length) throw bad(`The import file has problems:\n- ${problems.join("\n- ")}`);
	return area;
}

/**
 * Plan (and with `apply`, perform) an import for one profile. Returns a
 * summary of what was or would be created and skipped.
 */
async function importFile(profileId, file, { apply = false, overwrite = false } = {}) {
	const area = validate(file);
	const open = reviews(file);
	if (apply && open.length) throw bad(`Answer the ${open.length} review question(s) in the file first:\n- ${open.join("\n- ")}`);

	return projects.withTx(async (db) => {
		const fileProjects = file.projects || [];
		const fileConcerns = file.concerns || [];
		if (apply && overwrite) {
			const pk = fileProjects.map((p) => p.key);
			const ck = fileConcerns.map((c) => c.key);
			if (pk.length) await db.query("DELETE FROM athena_project WHERE profile_id = ? AND import_key IN (?)", [profileId, pk]);
			if (ck.length) await db.query("DELETE FROM athena_concern WHERE profile_id = ? AND import_key IN (?)", [profileId, ck]);
			if (file.charter) await db.query("DELETE FROM athena_area_charter WHERE profile_id = ? AND area = ?", [profileId, area]);
		}

		const [existingP] = await db.query("SELECT id, uuid, import_key FROM athena_project WHERE profile_id = ? AND import_key IS NOT NULL", [profileId]);
		const [existingC] = await db.query("SELECT import_key FROM athena_concern WHERE profile_id = ? AND import_key IS NOT NULL", [profileId]);
		const [[charterRow]] = await db.query("SELECT COUNT(*) AS n FROM athena_area_charter WHERE profile_id = ? AND area = ?", [profileId, area]);
		const uuidByKey = new Map(existingP.map((r) => [r.import_key, r.uuid]));
		const idByKey = new Map(existingP.map((r) => [r.import_key, r.id]));
		const haveConcern = new Set(existingC.map((r) => r.import_key));

		const summary = {
			applied: apply, area,
			charter: file.charter ? (charterRow.n ? "kept (already set)" : "created") : "none in file",
			projects: { created: [], skipped: [] },
			steps: 0, links: 0,
			concerns: { created: [], skipped: [] },
			reviews: open,
		};

		const created = [];
		for (const p of fileProjects) {
			if (uuidByKey.has(p.key)) { summary.projects.skipped.push(p.key); continue; }
			summary.projects.created.push(p.key);
			summary.steps += (p.steps || []).length;
			summary.links += (p.contributes_to || []).length + (p.depends_on || []).length;
			if (!apply) continue;
			const { id, uuid } = await projects.create(profileId, toInput(p, area), { source: "import", importKey: p.key, db });
			uuidByKey.set(p.key, uuid);
			idByKey.set(p.key, id);
			created.push(p);
		}
		if (apply) {
			for (const p of created) {
				for (const s of p.steps || []) await projects.addStep(profileId, uuidByKey.get(p.key), s, { db });
				for (const k of p.contributes_to || []) {
					await projects.addLink(profileId, uuidByKey.get(p.key), { relation: "contributes_to", to: uuidByKey.get(k) }, { db });
				}
				for (const d of p.depends_on || []) {
					await projects.addLink(profileId, uuidByKey.get(p.key), { relation: "depends_on", to: uuidByKey.get(d.key), note: d.note }, { db });
				}
			}
		}

		for (const c of fileConcerns) {
			if (haveConcern.has(c.key)) { summary.concerns.skipped.push(c.key); continue; }
			summary.concerns.created.push(c.key);
			if (!apply) continue;
			const input = {
				area, title: c.title, severity: c.severity, frequency: c.frequency, likelyCause: c.likely_cause,
				goalImpact: c.goal_impact, assessment: c.assessment, status: c.status,
			};
			const ids = (c.projects || []).map((k) => idByKey.get(k)).filter(Boolean);
			await projects.createConcern(profileId, input, { importKey: c.key, projectIds: ids, db });
		}

		if (apply && file.charter && !charterRow.n) await projects.putCharter(profileId, area, file.charter, { db });
		return summary;
	});
}

module.exports = { importFile, validate, reviews, toInput };
