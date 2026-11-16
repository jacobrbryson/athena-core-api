---
id: google-tasks
title: Google Tasks
summary: I read your Google Tasks lists and, on a card you approve, add, tick off, change or delete a task.
where: the ⋯ menu (top right) → Connected apps → Google → Tasks → Connect (or approve it when you sign in)
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

Your open tasks are also on the **Home** dashboard, on the **Tasks** card beside
**Your day**: overdue and soonest-due first, with the list each is on. Tick the
box beside one and it's ticked off in Google Tasks right away (the tick is
your approval); **Undo** reopens it for a moment afterwards.

## Where to find it

When you sign in with Google, Google's approval screen asks for Gmail,
Calendar, Contacts and Tasks together. Leave Tasks ticked and it's connected.

If you unticked it, the **⋯ menu in the top right corner** → **Connected
apps** → the **Google** card → the **Tasks** row → **Connect**, or the
**Connect** button on the Tasks card on Home. To turn it off, the Tasks row
has **Off**.

The Tasks card's **Open Google Tasks** button opens Google Tasks itself.

## When it doesn't work

- **I say Tasks isn't connected.** Connect it from the Tasks row on the
  Google card.
- **The Tasks row says reconnect.** Google withdrew the approval (a password
  change, or removing Athena in your Google account's third-party access
  page). Connect it again from the same row.
- **I can't find a task you can see.** It may be on a different Google
  account than the one you approved, or it's a completed task — ask me to
  include finished ones.
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
- UI: Tasks row on the Google card in
  `../../../companion/src/components/IntegrationsPanel.tsx`; line in
  `../../../companion/src/components/KnowsPanel.tsx`.
- Setup the owner must do once: enable the Google Tasks API on the GCP
  project and add the `.../auth/tasks` scope to the OAuth consent screen.
- Tests: `src/services/connectors/googleTasks.test.js`.
