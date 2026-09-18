---
id: actions
title: Doing things, not just saying them
summary: I can offer to actually change something — add a calendar event, save a fact — and you approve or decline it before anything happens.
where: the ⋯ menu (top right) → Actions
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [add to my calendar, put it on my calendar, book, schedule it, schedule that, make an event, create an event, can you do it, do it for me, remember that, actions, approve, without asking]
---

## What I can do

Most of what I do is read and answer. This is the part where I can change
something — but never on my own.

When you ask me to put something on your calendar, I don't do it. I propose it:
a card appears under my reply saying exactly what I'm about to do, and nothing
happens until you tap **Approve**. If you tap **No**, or leave it, nothing
happens at all. I genuinely cannot skip that step — it isn't restraint on my
part, it's how I'm built.

Two things I can propose today:

- **Add a calendar event** to your own Google Calendar.
- **Save a fact** to my long-term memory, when you ask me to remember
  something specific.

If you get tired of approving the same thing, you can tell me to stop asking:
tick **"Do this without asking me each time"** and I'll just do that one kind
of thing from then on. I still record every single one, and you can take that
permission back whenever you like.

You can see everything I've done, and everything I asked and you said no to,
in the same panel.

## Where to find it

The **⋯ menu in the top right corner** → **Actions**.

The first time, there's a switch to turn on: **"Let Athena propose changes"**.
Until you accept that, I stay read-only — I won't even offer.

Adding calendar events also needs Google Calendar connected (**⋯ menu** →
**Connected apps**), and it needs the *newer* connection. If you linked your
calendar before this feature existed, I can read it but not write to it; the
Actions panel will say so, and reconnecting it from **Connected apps** fixes
it.

Approval cards work on your paired phone or car too, not just in this browser.

## When it doesn't work

- **The card says "Expired".** Proposals only stay valid about fifteen
  minutes, on purpose — I don't want a card from this morning quietly adding
  something this evening. Just ask me again.
- **"I can read this calendar but not write to it yet."** Your Google
  connection predates this feature. Go to **⋯ menu** → **Connected apps** and
  reconnect Google Calendar; it will ask for one extra permission.
- **Approve did nothing and the card went red.** The error on the card is the
  real reason from Google, not my guess at it. Nothing was changed.
- **I said I'd do something but no card appeared.** Then I got the details
  wrong somewhere and the proposal was refused before it reached you — a time
  with no timezone is the usual culprit. Tell me the day and time again,
  plainly.

## Limits

- **I always ask first**, unless you explicitly ticked the box for that one
  kind of action. There is no way for me to act without either your tap or
  that box.
- **I can only add to your own primary calendar.** Not a shared household
  calendar, not someone else's.
- **I can't invite anyone to an event.** Adding guests would email them, and
  nobody approved that but you — add guests yourself afterwards.
- **I can't move, edit or cancel an existing event.** Only add a new one.
- **I can't schedule more than a year out**, or anything in the past, or a
  single event longer than two weeks.
- **One proposal per reply.** I won't queue up a batch of changes.
- **Children and Guardians can't approve anything**, and I won't offer them
  actions at all. This is the account owner's decision.
- **I can't undo an action for you.** Both of today's actions are things you
  can undo yourself — delete the event, delete the memory — and the card says
  so before you approve.

## Under the hood

**Never sent to a model.** The map for the next coding agent:

- Executor: `src/services/actions/index.js` — propose / confirm / decline,
  standing approvals, expiry. The only path to a provider call.
- Registry: `src/services/actions/registry.js` — one descriptor per action.
  `normalize()` is the untrusted-input boundary; adding an action should touch
  nothing else.
- Writes: `src/services/connectors/googleCalendar.js` (`createEvent`,
  `deleteEvent`) and `src/services/memory.js` (`upsertMemoryForProfile`).
- Model surface: `proposed_action` in `RESPONSE_SCHEMA`
  (`src/controllers/prompt.js`), prompt block from `actions.promptBlock()`,
  proposal created in `src/controllers/gemini.js`.
- Routes: `src/routes/actions.js` → `src/controllers/actions.js`.
  `GET /api/v1/actions`, `/pending`, `/history`,
  `POST /api/v1/actions/:uuid/confirm|decline`,
  `POST|DELETE /api/v1/actions/authority/:actionId`.
- Schema: `db/migrations/0026_athena_action.up.sql` — `athena_action`,
  `athena_action_authority`.
- Frontend: `../../../companion/src/components/ActionProposal.tsx` (card),
  `../../../companion/src/components/ActionsPanel.tsx` (panel),
  `../../../companion/src/athena/useActions.ts` (socket + poll).
- Expiry job: `src/jobs/nightly.js` (`actionExpiry` step).
- Tests: `src/services/actions/actions.test.js`.
- Design notes: `../../../docs/architecture/action-layer.md`.
- Notes: the chat path uses structured output, not function calling, which is
  *why* the propose/confirm gate is structural rather than a policy — Athena
  has no mechanism to invoke anything. Keep it that way. If a future action
  needs a tool-calling loop, the loop must still terminate in an
  `athena_action` row rather than a live call.
- Notes: `status: partial` because the Google write path has not been
  exercised against the live API, and existing calendar links need a re-consent
  for the `calendar.events` scope. Flip to `live` once both are settled.
