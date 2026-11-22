---
id: google-tasks
title: Google Tasks
summary: I read your Google Tasks lists and, on a card you approve, add, tick off, change or delete a task; Home's Tasks card can add one (or a Jira issue).
where: the ⋯ menu (top right) → Connected apps → Google → Tasks → Connect (or approve it when you sign in); Home → the Tasks card and the Open tasks tile
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [task, tasks, google tasks, to do, to-do, todo, to-dos, todos, to do list, task list, errand, errands, tick off, cross off, checklist]
---

## What I can do

With Google Tasks connected I can see every task list on your Google account
and the open tasks on each — their due dates and notes too — whenever you ask
about your to-dos ("what's on my list?", "anything due this week?").

I can also manage them, always on a card you approve first:

- **Add** a task to your default list or a list you name, with a due date and
  notes if you want.
- **Tick off** a task you've done, or reopen one; rename it, change its due
  date, or add a note to it.
- **Delete** a task. Google Tasks has no bin, so a deleted task is gone; when
  you've simply done something I'll offer to tick it off instead.

Adding a task can be put on a standing approval if you'd rather I just do it;
changes and deletions always ask.

Your near-term tasks are also on the **Home** dashboard, on the **Tasks** card
beside **Your Day**. It only lists Google Tasks due tomorrow or sooner (overdue
included; undated tasks and ones due later stay off the card) and the Jira
issues assigned to you that are **In Progress** or **Ready to Start** — nothing
in review, QA or the backlog. Its header says how many it's showing, how many
Jira issues are in progress, and how many are due today and overdue. Under it,
a ring splits that list by overdue, due today, later and no date, with the
share that isn't overdue ("on track") in the middle, and a small bar chart
counts everything open that's due on each of the next seven days. Google Tasks
has no "in progress", so only Jira's own status says In Progress. Then the
list: Jira issues In Progress first, then the rest soonest due first. A Google
Task has a coloured chip for its list (the icon comes from the list's name — a
house for Property, a sprout for Home, and so on); tick its box and it's ticked
off in Google Tasks right away (the tick is your approval): a line draws
through it, it leaves the card once Google has it, and **Undo** reopens it for
a moment afterwards. A Jira issue shows its key, status and project;
tapping it opens it here in the app, read-only: status, project, priority,
assignee, due date and parent, then the description, acceptance criteria,
subtasks, attachments and comments. I can't change Jira issues, so you move
it along in Jira itself.

The Tasks card's **Add task ＋** button opens a side panel where you add one
yourself. A toggle at the top picks **Google Tasks** or **Jira** (it remembers
the one you used last). For Google Tasks you give the task, choose the list,
and optionally a due date (No date, Today, Tomorrow or a date you pick) and
notes. For Jira you give a summary, choose the project, and optionally a due
date and description; it's created as a Task assigned to you and, with **Add
to the current sprint** ticked (the default), put in that project's active
sprint — the card only shows Jira issues in an open sprint. Pressing Add is
your approval, so there's no separate card. Jira creating needs your Jira
linked by API token; a Jira linked through Atlassian sign-in is read-only and
the panel says so.

The **Open tasks** tile on Home counts the same list — Google Tasks plus open
Jira issues.

## Where to find it

When you sign in with Google, Google's approval screen asks for Gmail,
Calendar, Contacts and Tasks together. Leave Tasks ticked and it's connected.

If you unticked it, the **⋯ menu in the top right corner** → **Connected
apps** → the **Google** card → the **Tasks** row → **Connect**, or the
**Connect** button on the Tasks card on Home. To turn it off, the Tasks row
has **Off**.

Everything stays in the app: the Tasks card doesn't link out to Google Tasks.
Its header's **Add task** opens the add panel, and when there are more than
five tasks, **Show N more** expands the list on the card (**Show fewer** folds
it back). Jira issues open read-only in the app too, never out to Jira.

## When it doesn't work

- **I say Tasks isn't connected.** Connect it from the Tasks row on the
  Google card.
- **The Tasks row says reconnect.** Google withdrew the approval (a password
  change, or removing Athena in your Google account's third-party access
  page). Connect it again from the same row.
- **I can't find a task you can see.** It may be on a different Google
  account than the one you approved, or it's a completed task — ask me to
  include finished ones.
- **Add task says Jira is read-only.** Your Jira is linked through Atlassian
  sign-in, which only allows reading. Creating issues needs the owner to add
  Jira to your account with an API token.
- **A new Jira issue isn't on the card.** The card shows Jira issues in an
  open sprint; if the project has no active sprint (or Jira refused the move),
  it's in the backlog.
- **Google is refusing my requests.** The Google Tasks API has to be switched
  on for Athena's Google project; that's a fix on the owner's side, not yours.

## Limits

- One task per card; I can't bulk-tick a whole list.
- A due date is a date, not a time — Google Tasks doesn't keep times, and
  there's no reminder alert from me for it.
- I don't create, rename or delete task lists themselves, or move a task
  between lists.
- Subtasks show as ordinary tasks.
- One Google account; never read for a child.

## Under the hood

- Connector: `src/services/connectors/googleTasks.js` — Tasks API v1
  (`/users/@me/lists`, `/lists/{id}/tasks`), every list read, open tasks by
  default. `buildContext` puts open tasks with their `task_id` into the prompt;
  tool `get_google_tasks`. Writes `createTask` / `updateTask` (PATCH) /
  `deleteTask` are only called from the action layer.
- Descriptor: `google_tasks` in `src/services/connectors/registry.js`
  (scope `tasks` + `openid email`), a member of the `google` group; wired
  into `src/services/connectors/context.js`.
- Actions in `src/services/actions/registry.js`: `add_google_task`
  (standing allowed, refuses a duplicate open title on that list),
  `update_google_task` and `delete_google_task` (never standing; both look
  the task up on the person's own lists via `findTask` before a card exists).
- Tasks card on Home: `getDashboard` in `src/services/dashboard.js` (`tasks`
  source, up to 50 open tasks), card `tasks` in `src/services/dashboardPriority.js`
  and `../../../companion/src/components/Dashboard.tsx` (after calendar), list
  in `../../../companion/src/components/TasksCard.tsx`. The checkbox and Undo
  are direct actions `complete_google_task` / `reopen_google_task`
  (DIRECT_ACTIONS, `POST /actions/direct/:id`), never offered to the model.
- Add task drawer (2026-11-20): `../../../companion/src/components/AddTaskDrawer.tsx`
  (+ `addTask.css`, on the Property drawers' `.pi-form`), opened from the
  header's `extra` slot in `CardHeader` (`YourDay.tsx`). Targets from
  `GET /api/v1/dashboard/task-targets` (`taskTargets` in
  `src/controllers/dashboard.js`: task lists + Jira projects the person can
  create in). Writes are direct actions `create_google_task` (reuses
  `add_google_task`'s normalize) and `create_jira_issue` (API-token links
  only; project checked against `listProjects`, issue type chosen in code by
  `taskType`, sprint resolved by `activeSprint`; `createIssue` in
  `jiraApiToken.js` assigns to `/myself` then moves it into the sprint — a
  refused sprint move does not fail the action). Tests:
  `src/services/connectors/jiraCreate.test.js` and the last block of
  `googleTasks.test.js`.
- Jira rows on the Tasks card open `../../../companion/src/components/JiraIssueDrawer.tsx`
  (read-only; `GET /api/v1/work-items/issue` → `src/services/workItems/jira.js` `read`,
  rendered with `JiraDocument` from `WorkItems.tsx`). Nothing on the card
  links out to Google Tasks or Jira (owner, 2026-11-20).
- UI: Tasks row on the Google card in
  `../../../companion/src/components/IntegrationsPanel.tsx`; line in
  `../../../companion/src/components/KnowsPanel.tsx`.
- Setup the owner must do once: enable the Google Tasks API on the GCP
  project and add the `.../auth/tasks` scope to the OAuth consent screen.
- Tests: `src/services/connectors/googleTasks.test.js`.
