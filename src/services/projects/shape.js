/**
 * Validation and row shaping for projects, shared by the service, the importer
 * and the tests. Pure: no database, no clock except where a timestamp is the
 * point.
 *
 * Unknown-by-omission is preserved everywhere. An absent field keeps what was
 * there; an explicit null clears it; and "nobody said" (indoor = NULL) is never
 * turned into an answer.
 */

const AREAS = ["health", "family", "community", "work", "home"];
const STATUSES = ["idea", "planning", "ready", "active", "waiting", "blocked", "done", "dropped"];
const CLOSED = new Set(["done", "dropped"]);
const STEP_STATUSES = ["todo", "in_progress", "blocked", "done", "skipped"];
const STEP_WHO = ["me", "someone", "athena"];
const RELATIONS = ["contributes_to", "depends_on"];
const CONCERN_STATUSES = ["open", "monitoring", "resolved"];
const CONDITIONS = ["dry", "mild", "warm", "cold", "during_rain", "after_rain", "no_freeze", "daylight"];
const VISIBILITY = ["private", "household"];
const ITEM_KINDS = ["spec", "material"];
const ITEM_STATUSES = ["confirmed", "pending", "estimate"];
const SESSION_STATUSES = ["planned", "in_progress", "completed", "skipped", "cancelled"];

const bad = (message) => Object.assign(new Error(message), { status: 400 });

const text = (value, max) =>
	typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

/** Field readers: `undefined` means "not mentioned", so keep `fallback`. */
const read = {
	text(value, max, fallback) {
		if (value === undefined) return fallback;
		return text(value, max);
	},
	pick(value, allowed, fallback, label) {
		if (value === undefined) {
			if (fallback === undefined) throw bad(`${label} is required.`);
			return fallback;
		}
		const v = String(value ?? "").toLowerCase();
		if (!allowed.includes(v)) throw bad(`${label} must be one of: ${allowed.join(", ")}.`);
		return v;
	},
	level(value, fallback, label) {
		if (value === undefined) return fallback;
		const n = Number(value);
		if (!Number.isInteger(n) || n < 1 || n > 5) throw bad(`${label} is 1 (low) to 5 (critical).`);
		return n;
	},
	minutes(value, fallback) {
		if (value === undefined) return fallback;
		if (value === null || value === "") return null;
		const n = Math.round(Number(value));
		if (!Number.isFinite(n) || n < 0 || n > 60 * 24 * 60) throw bad("Effort must be between 0 minutes and two months.");
		return n;
	},
	money(value, fallback) {
		if (value === undefined) return fallback;
		if (value === null || value === "") return null;
		const n = Number(String(value).replace(/[$,\s]/g, ""));
		if (!Number.isFinite(n) || n < 0 || n > 100_000_000) throw bad("That cost does not look right.");
		return Math.round(n * 100) / 100;
	},
	number(value, fallback) {
		if (value === undefined) return fallback;
		if (value === null || value === "") return null;
		const n = Number(value);
		if (!Number.isFinite(n) || Math.abs(n) > 1e8) throw bad("That number does not look right.");
		return Math.round(n * 100) / 100;
	},
	date(value, fallback, label = "That date") {
		if (value === undefined) return fallback;
		if (!value) return null;
		const s = String(value).slice(0, 10);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad(`${label} is not a date I can read (use YYYY-MM-DD).`);
		return s;
	},
	/**
	 * A moment, stored as UTC "YYYY-MM-DD HH:MM:SS". A bare date means midday
	 * UTC — morning across the US — so "review Thursday" is due on Thursday
	 * wherever they are. An offsetless time is refused: it would be read in
	 * whatever zone the server happens to be in.
	 */
	when(value, fallback, label = "That time") {
		if (value === undefined) return fallback;
		if (!value) return null;
		const raw = value instanceof Date ? value.toISOString() : String(value).trim();
		const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00Z` : raw;
		if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) throw bad(`${label} needs a date (YYYY-MM-DD) or a time with its UTC offset.`);
		const t = Date.parse(iso);
		if (!Number.isFinite(t)) throw bad(`${label} is not a time I can read.`);
		return new Date(t).toISOString().slice(0, 19).replace("T", " ");
	},
	tri(value, fallback) {
		if (value === undefined) return fallback;
		if (value === null || value === "") return null;
		return !!value;
	},
	bool(value, fallback) {
		if (value === undefined) return fallback;
		return !!value;
	},
	months(value, fallback) {
		if (value === undefined) return fallback;
		if (value === null || (Array.isArray(value) && !value.length)) return null;
		if (!Array.isArray(value)) throw bad("Season is a list of months, 1–12.");
		const set = [...new Set(value.map(Number))].sort((a, b) => a - b);
		if (set.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) throw bad("Season is a list of months, 1–12.");
		return set.length === 12 ? null : set;
	},
	list(value, fallback, { allowed = null, max = 20, label = "That list" } = {}) {
		if (value === undefined) return fallback;
		if (value === null) return [];
		if (!Array.isArray(value)) throw bad(`${label} must be a list.`);
		const out = [...new Set(value.map((v) => String(v ?? "").trim().toLowerCase()).filter(Boolean))].slice(0, max);
		if (allowed) {
			const unknown = out.filter((v) => !allowed.includes(v));
			if (unknown.length) throw bad(`${label}: unknown ${unknown.join(", ")}. Use ${allowed.join(", ")}.`);
		}
		if (out.some((v) => v.length > 32)) throw bad(`${label}: each entry is at most 32 characters.`);
		return out;
	},
};

const monthsToMask = (months) => (months && months.length ? months.reduce((m, n) => m | (1 << (n - 1)), 0) : null);
const maskToMonths = (mask) => {
	if (mask === null || mask === undefined) return null;
	const out = [];
	for (let i = 0; i < 12; i++) if (mask & (1 << i)) out.push(i + 1);
	return out;
};

/**
 * "Done when" and acceptance criteria are written one per line; bullets and
 * empty checkboxes are the person's formatting, not part of the criterion.
 */
const criteriaOf = (value) =>
	String(value || "")
		.split(/\r?\n/)
		.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[\s?[xX]?\s?\])\s*/, "").trim())
		.filter(Boolean)
		.slice(0, 40);

/**
 * Normalise a submitted project against what exists (or nothing, on create).
 * Returns column values. Areas are handled separately — see normalizeAreas.
 */
function normalizeProject(input = {}, existing = null) {
	const e = existing || {};
	const title = read.text(input.title, 190, e.title ?? null);
	if (!title) throw bad("A project needs a title.");
	const status = read.pick(input.status, STATUSES, e.status ?? "idea", "Status");
	const effort = input.effort === undefined ? {} : input.effort || { min: null, max: null, note: null };
	const cost = input.cost === undefined ? {} : input.cost || { diyLow: null, diyHigh: null, proLow: null, proHigh: null, note: null };
	const metric = input.metric === undefined ? {} : input.metric || { source: null, start: null, target: null, unit: null };
	const budget = input.budget === undefined ? {} : input.budget || { working: null, ceiling: null, note: null };
	const out = {
		title,
		goal: read.text(input.goal, 8000, e.goal ?? null),
		kind: read.text(input.kind, 32, e.kind ?? null)?.toLowerCase() ?? null,
		status,
		// A reason to wait only means something while waiting.
		waiting_on: status === "waiting" ? read.text(input.waitingOn, 32, e.waitingOn ?? null) : null,
		priority: read.level(input.priority, e.priority ?? 3, "Priority"),
		starts_on: read.date(input.startsOn, e.startsOn ?? null, "Start date"),
		ends_on: read.date(input.endsOn, e.endsOn ?? null, "End date"),
		hard_deadline: read.date(input.hardDeadline, e.hardDeadline ?? null, "Deadline"),
		metric_source: read.text(metric.source, 48, e.metric?.source ?? null),
		metric_start: read.number(metric.start, e.metric?.start ?? null),
		metric_target: read.number(metric.target, e.metric?.target ?? null),
		metric_unit: read.text(metric.unit, 16, e.metric?.unit ?? null),
		effort_min_minutes: read.minutes(effort.min, e.effort?.min ?? null),
		effort_max_minutes: read.minutes(effort.max, e.effort?.max ?? null),
		effort_note: read.text(effort.note, 64, e.effort?.note ?? null),
		indoor: read.tri(input.indoor, e.indoor ?? null),
		cost_diy_low: read.money(cost.diyLow, e.cost?.diyLow ?? null),
		cost_diy_high: read.money(cost.diyHigh, e.cost?.diyHigh ?? null),
		cost_pro_low: read.money(cost.proLow, e.cost?.proLow ?? null),
		cost_pro_high: read.money(cost.proHigh, e.cost?.proHigh ?? null),
		cost_note: read.text(cost.note, 190, e.cost?.note ?? null),
		value_note: read.text(input.valueNote, 255, e.valueNote ?? null),
		season_months: read.months(input.seasonMonths, e.seasonMonths ?? null),
		conditions: read.list(input.conditions, e.conditions ?? [], { allowed: CONDITIONS, label: "Conditions" }),
		serves: read.list(input.serves, e.serves ?? [], { label: "Serves" }),
		involves_children: read.bool(input.involvesChildren, e.involvesChildren ?? false),
		visibility: read.pick(input.visibility, VISIBILITY, e.visibility ?? "private", "Visibility"),
		ref_code: read.text(input.refCode, 48, e.refCode ?? null),
		revision: read.text(input.revision, 16, e.revision ?? null),
		// Pinning again moves it to the front of the other pins: newest pin first.
		pinned_at: input.pinned === undefined ? (e.pinnedAt ?? null) : input.pinned ? new Date() : null,
		budget_working: read.money(budget.working, e.budget?.working ?? null),
		budget_ceiling: read.money(budget.ceiling, e.budget?.ceiling ?? null),
		budget_note: read.text(budget.note, 190, e.budget?.note ?? null),
		done_when: read.text(input.doneWhen, 4000, e.doneWhen ?? null),
	};
	// What they have ticked off on the closeout checklist, by criterion text, so
	// rewording a criterion un-ticks it. Only criteria that still exist count.
	const criteria = criteriaOf(out.done_when);
	let ticked = e.doneWhenConfirmed ?? [];
	if (input.doneWhenConfirmed !== undefined) {
		if (input.doneWhenConfirmed !== null && !Array.isArray(input.doneWhenConfirmed)) throw bad("Confirmed criteria must be a list.");
		ticked = (input.doneWhenConfirmed || []).map((c) => String(c ?? "").trim());
	}
	out.done_when_confirmed = [...new Set(ticked)].filter((c) => criteria.includes(c));
	if (out.budget_working !== null && out.budget_ceiling !== null && out.budget_working > out.budget_ceiling) {
		throw bad("Budget: the working budget is above the approval ceiling.");
	}
	if (out.effort_min_minutes !== null && out.effort_max_minutes !== null && out.effort_min_minutes > out.effort_max_minutes) {
		throw bad("Effort: the low end is above the high end.");
	}
	for (const [lo, hi, label] of [["cost_diy_low", "cost_diy_high", "DIY cost"], ["cost_pro_low", "cost_pro_high", "Hired-out cost"]]) {
		if (out[lo] !== null && out[hi] !== null && out[lo] > out[hi]) throw bad(`${label}: the low end is above the high end.`);
	}
	if (out.starts_on && out.ends_on && out.starts_on > out.ends_on) throw bad("The end date is before the start date.");
	// Household sharing needs a household model that does not exist yet.
	if (out.visibility === "household") throw bad("Sharing with your household is not available yet.");
	return out;
}

/**
 * Areas: a list of area names plus the primary. Exactly one primary, and it
 * must be one of the areas. Returns null when neither was mentioned.
 */
function normalizeAreas(input = {}, existing = null) {
	if (input.areas === undefined && input.primaryArea === undefined) {
		return existing ? null : [{ area: "home", primary: true }];
	}
	const prevAreas = existing?.areas?.map((a) => a.area) ?? [];
	const areas = read.list(input.areas, prevAreas, { allowed: AREAS, label: "Areas" });
	const primary = read.pick(input.primaryArea, AREAS, existing?.primaryArea ?? areas[0] ?? "home", "Primary area");
	if (!areas.includes(primary)) areas.unshift(primary);
	return areas.map((area) => ({ area, primary: area === primary }));
}

function normalizeStep(input = {}, existing = null) {
	const e = existing || {};
	const title = read.text(input.title, 190, e.title ?? null);
	if (!title) throw bad("A step needs a title.");
	const status = read.pick(input.status, STEP_STATUSES, e.status ?? "todo", "Step status");
	// A blocker's follow-through (what, who, when to look again, what clears it)
	// only means something while it is blocked; unblocking clears all four.
	const blocked = status === "blocked";
	return {
		title,
		detail: read.text(input.detail, 4000, e.detail ?? null),
		// A grouping label for the plan; it never gates anything.
		phase: read.text(input.phase, 64, e.phase ?? null),
		acceptance_criteria: read.text(input.acceptanceCriteria, 4000, e.acceptanceCriteria ?? null),
		status,
		who: read.pick(input.who, STEP_WHO, e.who ?? "me", "Who"),
		blocked_on: blocked ? read.text(input.blockedOn, 190, e.blockedOn ?? null) : null,
		waiting_on_actor: blocked ? read.text(input.waitingOnActor, 190, e.waitingOnActor ?? null) : null,
		review_at: blocked ? read.when(input.reviewAt, e.reviewAt ? read.when(e.reviewAt) : null, "Review date") : null,
		unblock_action: blocked ? read.text(input.unblockAction, 190, e.unblockAction ?? null) : null,
		due_on: read.date(input.dueOn, e.dueOn ?? null, "Due date"),
		effort_minutes: read.minutes(input.effortMinutes, e.effortMinutes ?? null),
		indoor: read.tri(input.indoor, e.indoor ?? null),
	};
}

/**
 * Time set aside to work. Its step, if any, is resolved by the service against
 * the same project — a session can never point at another project's step.
 */
function normalizeSession(input = {}, existing = null) {
	const e = existing || {};
	const start = read.when(input.plannedStart, e.plannedStart ? read.when(e.plannedStart) : undefined, "Start");
	if (!start) throw bad("A work session needs a start time.");
	const minutes = read.minutes(input.plannedMinutes, e.plannedMinutes ?? undefined);
	if (!minutes) throw bad("Say how long the session is, in minutes.");
	if (minutes > 16 * 60) throw bad("A single session is at most 16 hours — split longer work into several.");
	const status = read.pick(input.status, SESSION_STATUSES, e.status ?? "planned", "Session status");
	const actual = read.minutes(input.actualMinutes, e.actualMinutes ?? null);
	return {
		planned_start: start,
		planned_duration_minutes: minutes,
		actual_duration_minutes: actual,
		status,
		made_progress: read.tri(input.madeProgress, e.madeProgress ?? null),
		notes: read.text(input.notes, 4000, e.notes ?? null),
	};
}

const iso = (v) => {
	if (!v) return null;
	if (v instanceof Date) return v.toISOString();
	const s = String(v);
	return /(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? new Date(s).toISOString() : new Date(`${s.replace(" ", "T")}Z`).toISOString();
};

function toSession(row, stepUuid = null) {
	return {
		uuid: row.uuid,
		stepUuid,
		plannedStart: iso(row.planned_start),
		plannedMinutes: Number(row.planned_duration_minutes),
		actualMinutes: num(row.actual_duration_minutes),
		status: row.status,
		madeProgress: row.made_progress === null || row.made_progress === undefined ? null : !!row.made_progress,
		calendarEventId: row.calendar_event_id || null,
		// On the calendar at the time it's planned for; false once rescheduled until the event is moved too.
		calendarInSync: row.calendar_event_id ? iso(row.calendar_start) === iso(row.planned_start) : null,
		notes: row.notes || null,
		completedAt: iso(row.completed_at),
		createdAt: iso(row.created_at),
	};
}

/** A spec (a measurement or decision) or a material (a takeoff line), each confirmed, pending or an estimate. */
function normalizeItem(input = {}, existing = null) {
	const e = existing || {};
	const label = read.text(input.label, 190, e.label ?? null);
	if (!label) throw bad("Say what it is — a label like \"Fence length\".");
	const out = {
		kind: read.pick(input.kind, ITEM_KINDS, e.kind ?? "spec", "Kind"),
		label,
		value: read.text(input.value, 64, e.value ?? null),
		unit: read.text(input.unit, 16, e.unit ?? null),
		status: read.pick(input.status, ITEM_STATUSES, e.status ?? "pending", "Item status"),
		cost_low: read.money(input.costLow, e.costLow ?? null),
		cost_high: read.money(input.costHigh, e.costHigh ?? null),
		note: read.text(input.note, 255, e.note ?? null),
	};
	if (out.cost_low !== null && out.cost_high !== null && out.cost_low > out.cost_high) throw bad("Cost: the low end is above the high end.");
	return out;
}

function toItem(row) {
	return {
		uuid: row.uuid,
		kind: row.kind,
		ordinal: Number(row.ordinal),
		label: row.label,
		value: row.value || null,
		unit: row.unit || null,
		status: row.status,
		costLow: num(row.cost_low),
		costHigh: num(row.cost_high),
		note: row.note || null,
		confirmedAt: row.confirmed_at || null,
	};
}

function normalizeConcern(input = {}, existing = null) {
	const e = existing || {};
	const title = read.text(input.title, 190, e.title ?? null);
	if (!title) throw bad("A concern needs a title.");
	return {
		area: read.pick(input.area, AREAS, e.area ?? "home", "Area"),
		title,
		severity: read.level(input.severity, e.severity ?? 3, "Severity"),
		frequency: read.text(input.frequency, 64, e.frequency ?? null),
		likely_cause: read.text(input.likelyCause, 4000, e.likelyCause ?? null),
		goal_impact: read.text(input.goalImpact, 255, e.goalImpact ?? null),
		assessment: read.text(input.assessment, 8000, e.assessment ?? null),
		status: read.pick(input.status, CONCERN_STATUSES, e.status ?? "open", "Concern status"),
	};
}

function normalizeCharter(input = {}) {
	const body = text(input.body, 60000);
	if (!body) throw bad("The charter needs some text.");
	let weights = null;
	if (input.weights !== undefined && input.weights !== null) {
		if (typeof input.weights !== "object" || Array.isArray(input.weights)) throw bad("Weights are a map of goal → 0–10.");
		weights = {};
		for (const [k, v] of Object.entries(input.weights).slice(0, 40)) {
			const key = String(k).trim().toLowerCase().replace(/\s+/g, "_").slice(0, 32);
			const n = Number(v);
			if (!key || !Number.isFinite(n) || n < 0 || n > 10) throw bad(`Weight for "${k}" must be 0–10.`);
			weights[key] = Math.round(n * 10) / 10;
		}
	}
	return { body, weights };
}

const json = (value) => {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") {
		try { return JSON.parse(value); } catch { return null; }
	}
	return value;
};
const num = (v) => (v === null || v === undefined ? null : Number(v));
const day = (v) => {
	if (!v) return null;
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	return String(v).slice(0, 10);
};

function toProject(row) {
	return {
		uuid: row.uuid,
		title: row.title,
		goal: row.goal || null,
		kind: row.kind || null,
		status: row.status,
		waitingOn: row.waiting_on || null,
		priority: Number(row.priority),
		startsOn: day(row.starts_on),
		endsOn: day(row.ends_on),
		hardDeadline: day(row.hard_deadline),
		metric: row.metric_source || row.metric_target !== null
			? { source: row.metric_source || null, start: num(row.metric_start), target: num(row.metric_target), unit: row.metric_unit || null }
			: null,
		effort: { min: num(row.effort_min_minutes), max: num(row.effort_max_minutes), note: row.effort_note || null },
		indoor: row.indoor === null || row.indoor === undefined ? null : !!row.indoor,
		cost: {
			diyLow: num(row.cost_diy_low), diyHigh: num(row.cost_diy_high),
			proLow: num(row.cost_pro_low), proHigh: num(row.cost_pro_high),
			note: row.cost_note || null,
		},
		valueNote: row.value_note || null,
		seasonMonths: maskToMonths(row.season_months),
		conditions: json(row.conditions) || [],
		serves: json(row.serves) || [],
		involvesChildren: !!row.involves_children,
		visibility: row.visibility,
		lastProgressAt: row.last_progress_at || null,
		completedAt: row.completed_at || null,
		source: row.source,
		importKey: row.import_key || null,
		refCode: row.ref_code || null,
		revision: row.revision || null,
		pinnedAt: row.pinned_at || null,
		budget: { working: num(row.budget_working), ceiling: num(row.budget_ceiling), note: row.budget_note || null },
		doneWhen: row.done_when || null,
		doneWhenConfirmed: json(row.done_when_confirmed) || [],
		outcomeConfirmedAt: row.outcome_confirmed_at || null,
		activatedAt: row.activated_at || null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function toStep(row) {
	return {
		uuid: row.uuid,
		ordinal: Number(row.ordinal),
		title: row.title,
		detail: row.detail || null,
		phase: row.phase || null,
		acceptanceCriteria: row.acceptance_criteria || null,
		status: row.status,
		who: row.who,
		blockedOn: row.blocked_on || null,
		waitingOnActor: row.waiting_on_actor || null,
		reviewAt: iso(row.review_at),
		unblockAction: row.unblock_action || null,
		dueOn: day(row.due_on),
		effortMinutes: num(row.effort_minutes),
		indoor: row.indoor === null || row.indoor === undefined ? null : !!row.indoor,
		completedAt: row.completed_at || null,
	};
}

function toConcern(row) {
	return {
		uuid: row.uuid,
		area: row.area,
		title: row.title,
		severity: Number(row.severity),
		frequency: row.frequency || null,
		likelyCause: row.likely_cause || null,
		goalImpact: row.goal_impact || null,
		assessment: row.assessment || null,
		status: row.status,
		resolvedAt: row.resolved_at || null,
		importKey: row.import_key || null,
		updatedAt: row.updated_at,
	};
}

/**
 * Would adding from → to under `relation` close a loop? `edges` is the
 * existing [from, to] pairs for that relation only.
 */
function wouldCycle(edges, from, to) {
	if (from === to) return true;
	const next = new Map();
	for (const [a, b] of edges) {
		if (!next.has(a)) next.set(a, []);
		next.get(a).push(b);
	}
	const seen = new Set();
	const stack = [to];
	while (stack.length) {
		const n = stack.pop();
		if (n === from) return true;
		if (seen.has(n)) continue;
		seen.add(n);
		for (const m of next.get(n) || []) stack.push(m);
	}
	return false;
}

/**
 * What a person sees as the status. A project they set as anything but closed
 * is blocked while something it depends on is still open — a dropped
 * dependency no longer holds anything up.
 */
function effectiveStatus(project, dependencies) {
	if (CLOSED.has(project.status)) return project.status;
	if (dependencies.some((d) => !CLOSED.has(d.status))) return "blocked";
	return project.status;
}

module.exports = {
	AREAS, STATUSES, CLOSED, STEP_STATUSES, STEP_WHO, RELATIONS, CONCERN_STATUSES, CONDITIONS, ITEM_KINDS, ITEM_STATUSES, SESSION_STATUSES,
	bad, read, monthsToMask, maskToMonths, criteriaOf,
	normalizeProject, normalizeAreas, normalizeStep, normalizeItem, normalizeConcern, normalizeCharter, normalizeSession,
	toProject, toStep, toItem, toConcern, toSession, wouldCycle, effectiveStatus,
};
