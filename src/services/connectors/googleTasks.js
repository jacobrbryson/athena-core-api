const { providerGet, providerRequest, isNotConnected } = require("./http");

/**
 * Google Tasks reads, and the writes the action layer can propose.
 *
 * Added on the owner's instruction, 2026-11-12: "a connection to my google
 * tasks in the linked apps that can be managed from Athena". A member of the
 * `google` group, so sign-in consents to it with Gmail, Calendar and Contacts.
 *
 * Reads are unconditional. `createTask`, `updateTask` and `deleteTask` are
 * never called from a context builder or a tool loop — only from
 * services/actions, after a person approved the specific proposal. They take
 * params normalize() already vouched for and interpret nothing of their own.
 *
 * Every list the account holds is read, not only the default one: people keep
 * "Groceries", "House" and "Work" lists side by side, and reading one list
 * made the others look empty.
 */

const PROVIDER = "google_tasks";
const LABEL = "Google Tasks";
// Guards against pathological accounts, not product limits.
const MAX_LISTS = 20;
const MAX_TASKS_PER_LIST = 100;
const MAX_CONTEXT_TASKS = 60;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const KEYWORDS =
	/\b(tasks?|to-?dos?|to do( list)?|todo list|google tasks|task list|checklist|errands?|(on|off|to|from) my list|cross (it|that) off|tick (it|that) off)\b/i;

/** Cheap gate: is this message plausibly about the person's tasks? */
function matches(message) {
	return typeof message === "string" && KEYWORDS.test(message);
}

/** The person's task lists, default list first, as { id, title }. */
async function listTaskLists(profileId, { actor = "athena" } = {}) {
	const data = await providerGet(profileId, PROVIDER, "/users/@me/lists", {
		actor,
		query: { maxResults: 100 },
	});
	return (data?.items || [])
		.filter((l) => l && l.id)
		.slice(0, MAX_LISTS)
		.map((l) => ({ id: String(l.id), title: String(l.title || "My Tasks").slice(0, 200) }));
}

/** One Tasks API task -> the flat shape the model and the actions see. */
function normalizeTask(task, list) {
	if (!task || !task.id || task.deleted) return null;
	const title = String(task.title || "").trim();
	return {
		id: String(task.id),
		list_id: list.id,
		list: list.title,
		title: title.slice(0, 300) || "(untitled)",
		...(task.notes ? { notes: String(task.notes).slice(0, 1000) } : {}),
		// Tasks stores only a date; the time part is always midnight UTC.
		...(task.due ? { due: String(task.due).slice(0, 10) } : {}),
		done: task.status === "completed",
		...(task.completed ? { completed_at: String(task.completed) } : {}),
		...(task.parent ? { parent_id: String(task.parent) } : {}),
		...(task.webViewLink ? { link: String(task.webViewLink) } : {}),
	};
}

/** Tasks on one list. Open ones only unless `showCompleted`. */
async function listTasks(profileId, list, { showCompleted = false, actor = "athena" } = {}) {
	const data = await providerGet(profileId, PROVIDER, `/lists/${encodeURIComponent(list.id)}/tasks`, {
		actor,
		// One list failing (a list deleted mid-read) says nothing about the link.
		invalidateOnAuthFailure: false,
		query: {
			maxResults: MAX_TASKS_PER_LIST,
			showCompleted: showCompleted ? "true" : "false",
			showHidden: showCompleted ? "true" : "false",
		},
	});
	return (data?.items || []).map((t) => normalizeTask(t, list)).filter(Boolean);
}

/** Order: overdue and dated first (soonest due), then undated, list order kept. */
function byDue(a, b) {
	if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
	if (a.due) return -1;
	if (b.due) return 1;
	return 0;
}

/** Every list and its tasks. Lists that fail to read are named, not hidden. */
async function collectTasks(profileId, { showCompleted = false, list: only = null } = {}) {
	const lists = await listTaskLists(profileId);
	const chosen = only ? lists.filter((l) => l.id === only.id) : lists;
	const failed = [];
	const perList = await Promise.all(
		chosen.map((l) =>
			listTasks(profileId, l, { showCompleted }).catch((err) => {
				if (isNotConnected(err)) throw err;
				failed.push(l.title);
				return [];
			})
		)
	);
	const tasks = perList.flat();
	return { lists, tasks, failed };
}

/**
 * The list a proposal names, by id or by title (case-insensitive), or the
 * default list when none is named. Null when a name was given and matches
 * nothing — the caller refuses rather than writing somewhere else.
 */
async function resolveList(profileId, nameOrId) {
	const lists = await listTaskLists(profileId);
	if (!lists.length) return null;
	const wanted = typeof nameOrId === "string" ? nameOrId.trim() : "";
	if (!wanted) return lists[0];
	return (
		lists.find((l) => l.id === wanted) ||
		lists.find((l) => l.title.toLowerCase() === wanted.toLowerCase()) ||
		null
	);
}

/** One task on one of the person's own lists, or null when it isn't there. */
async function getTask(profileId, list, taskId) {
	if (!list || !taskId) return null;
	let task;
	try {
		task = await providerGet(
			profileId,
			PROVIDER,
			`/lists/${encodeURIComponent(list.id)}/tasks/${encodeURIComponent(taskId)}`,
			{ invalidateOnAuthFailure: false }
		);
	} catch (err) {
		if (err?.providerStatus === 404 || err?.providerStatus === 400 || err?.status === 404) return null;
		throw err;
	}
	return normalizeTask(task, list);
}

/**
 * Find a task by id across every list (or the named one). The model sees ids
 * with their list, but it drops the list often enough that searching beats
 * refusing — and the search only ever covers this person's own lists.
 */
async function findTask(profileId, taskId, listName = null) {
	if (!taskId) return null;
	if (listName) {
		const list = await resolveList(profileId, listName);
		return list ? getTask(profileId, list, taskId) : null;
	}
	const lists = await listTaskLists(profileId);
	for (const list of lists) {
		const task = await getTask(profileId, list, taskId);
		if (task) return task;
	}
	return null;
}

function dueLabel(due, today) {
	if (!due) return "";
	if (due < today) return ` (overdue, was due ${due})`;
	if (due === today) return " (due today)";
	return ` (due ${due})`;
}

/**
 * Plain-text grounding for the system prompt. Ids ride along so a "tick off
 * the dentist one" can become a proposal without another read.
 */
async function buildContext(profileId) {
	const { lists, tasks, failed } = await collectTasks(profileId);
	const today = new Date().toISOString().slice(0, 10);
	const failedLine = failed.length ? [`(Could not read these lists just now: ${failed.join(", ")}.)`] : [];
	if (!lists.length) return "Google Tasks: connected, but the account has no task lists.";
	if (!tasks.length) {
		return [`Google Tasks: no open tasks (checked ${lists.map((l) => `"${l.title}"`).join(", ")}).`, ...failedLine].join("\n");
	}
	const shown = [...tasks].sort(byDue).slice(0, MAX_CONTEXT_TASKS);
	return [
		`Google Tasks — ${tasks.length} open task${tasks.length === 1 ? "" : "s"} across ` +
			`${lists.map((l) => `"${l.title}"`).join(", ")} (today is ${today} UTC). ` +
			`Changing one needs the person's approval through an action; never say it is done before that.`,
		...shown.map(
			(t) =>
				`- ${t.title}${dueLabel(t.due, today)} — list "${t.list}" [task_id ${t.id}]` +
				(t.notes ? ` — notes: ${t.notes.replace(/\s+/g, " ").slice(0, 160)}` : "")
		),
		...(tasks.length > shown.length ? [`(Only the first ${shown.length} are shown.)`] : []),
		...failedLine,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Writes (action layer only)
// ---------------------------------------------------------------------------

/** Tasks wants RFC 3339 and keeps only the date. */
const dueStamp = (date) => `${date}T00:00:00.000Z`;

async function createTask(profileId, params = {}) {
	const created = await providerRequest(profileId, PROVIDER, `/lists/${encodeURIComponent(params.list_id)}/tasks`, {
		method: "POST",
		body: {
			title: params.title,
			...(params.notes ? { notes: params.notes } : {}),
			...(params.due ? { due: dueStamp(params.due) } : {}),
		},
	});
	return { ref: created?.id || null, link: created?.webViewLink || null };
}

/**
 * A PATCH of exactly the fields normalize() put in params. Reopening clears
 * `completed`, which Tasks otherwise keeps and shows as done.
 */
async function updateTask(profileId, params = {}) {
	const body = {
		...(params.title ? { title: params.title } : {}),
		...(params.notes !== undefined ? { notes: params.notes } : {}),
		...(params.due ? { due: dueStamp(params.due) } : {}),
		...(params.done === true ? { status: "completed" } : {}),
		...(params.done === false ? { status: "needsAction", completed: null } : {}),
	};
	const updated = await providerRequest(
		profileId,
		PROVIDER,
		`/lists/${encodeURIComponent(params.list_id)}/tasks/${encodeURIComponent(params.task_id)}`,
		{ method: "PATCH", body }
	);
	return { ref: updated?.id || params.task_id, link: updated?.webViewLink || null };
}

async function deleteTask(profileId, params = {}) {
	await providerRequest(
		profileId,
		PROVIDER,
		`/lists/${encodeURIComponent(params.list_id)}/tasks/${encodeURIComponent(params.task_id)}`,
		{ method: "DELETE" }
	);
	return { ref: params.task_id };
}

// ---------------------------------------------------------------------------
// Gemini tools
// ---------------------------------------------------------------------------

const FUNCTION_DECLARATIONS = [
	{
		name: "get_google_tasks",
		description:
			"List the person's Google Tasks: every task list on the account and the tasks on it, " +
			"with each task's id, list, due date (a date only) and notes. Open tasks only unless " +
			"include_completed. Use for any question about their to-dos, and to find a task's id " +
			"before proposing to complete, change or delete it. Reading needs no approval.",
		parameters: {
			type: "OBJECT",
			properties: {
				list: { type: "STRING", description: "Optional: one list's exact title to read instead of all of them." },
				include_completed: { type: "BOOLEAN", description: "Also return tasks already ticked off." },
			},
		},
	},
];

async function executeTool(name, args = {}, { profileId }) {
	if (name !== "get_google_tasks") throw new Error(`Unknown Google Tasks tool: ${name}`);
	let only = null;
	if (args.list) {
		only = await resolveList(profileId, args.list);
		if (!only) {
			const lists = await listTaskLists(profileId);
			return { error: `No task list called "${args.list}"`, lists: lists.map((l) => l.title) };
		}
	}
	const { lists, tasks, failed } = await collectTasks(profileId, { showCompleted: args.include_completed === true, list: only });
	return {
		lists: lists.map((l) => ({ id: l.id, title: l.title })),
		tasks: [...tasks].sort(byDue),
		...(failed.length ? { unreadable_lists: failed } : {}),
		today: new Date().toISOString().slice(0, 10),
	};
}

module.exports = {
	PROVIDER,
	LABEL,
	DATE_ONLY,
	matches,
	listTaskLists,
	listTasks,
	collectTasks,
	resolveList,
	getTask,
	findTask,
	buildContext,
	createTask,
	updateTask,
	deleteTask,
	FUNCTION_DECLARATIONS,
	executeTool,
	// exported for tests
	normalizeTask,
};
