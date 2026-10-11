---
id: time-reminders
title: Time reminders
summary: Tell me "at 7 tomorrow, remind me to…" and I'll send it to your phone at that time.
where: ask me in conversation; see or remove them on the Community page → Reminders
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [remind me at, remind me tomorrow, remind me tonight, remind me in the morning, remind me later, reminder at, set a reminder, alarm, at 7, o'clock]
---

## What I can do

Ask me to remind you of something at a time — "at 7 tomorrow, remind me to
tell Ashlyn to text her brother" — and I'll send it to your phone at that
time as a notification. It's in our conversation too.

I say the time back before I set it, and a card shows exactly what I'll set:
the day, the time and the words. Nothing is set until you tap **Approve**
(or you've ticked **"Do this without asking me each time"** for reminders).

A reminder you asked for isn't me interrupting you, so quiet hours and the
Initiative switch don't hold it back.

## Where to find it

Just ask me. Everything waiting is on the **Community** page under
**Reminders**, with a **Remove** button on each.

To reach your phone it needs **Reach me outside the app** switched on in the
**⋯ menu** → **Initiative**.

## When it doesn't work

- **It came a little late.** It usually arrives within a couple of minutes of
  the time. If something went wrong setting its alarm, an hourly check still sends
  it, so at worst it's up to an hour late — never lost.
- **It never reached my phone.** It's still in our conversation. I try the
  phone again every couple of minutes, a few times, before I stop.
- **I said the time was in the past.** Tell me the day as well as the time.

## Limits

- **Up to a year ahead, and up to 50 waiting at once.**
- **Only to you.** I can't remind someone else yet.
- **It doesn't repeat.** "Every Monday" isn't something I can set yet.
- **I can't remove or change one for you.** Remove it on the Community page
  and ask me again.

## Under the hood

**Never sent to a model.** The map for the next coding agent:

- Action: `remind_at_time` in `src/services/actions/registry.js`
  (`whenOf()` reads an offsetless time in `time_zone`).
- Service: `src/services/timeReminders.js` — `create`, `list`, `cancel`,
  `fireDue` (claim → nudge with dedupe key `<uuid>:time` → push; back to
  armed on a failed push, done after `MAX_ATTEMPTS`), `promptBlock`.
- Job: `src/jobs/reminders.js`, Cloud Run Job `athena-reminders`. NOT on a
  schedule (owner, 2026-10-11: no every-minute poller — cost). Each reminder
  books one Cloud Task (queue `athena-reminders`, us-central1) for its own
  time that calls the Run API `jobs/athena-reminders:run`
  (`src/services/reminderWakeups.js`; tasks named by the minute, so one run
  per minute however many are due). Backstop: the hourly `athena-incidents`
  run (`src/jobs/incidents.js` `reminderBackstop`). Also runs the
  place-reminder expiry sweep. Listed in `cloudbuild.yaml` `_JOBS`.
- Routes: shares `/api/v1/place-reminders` (list returns `timeReminders`;
  DELETE tries the place reminder, then the time one).
- Schema: `db/migrations/0059_reminder_conditions.up.sql`
  (`athena_time_reminder`). Times are compared from the app, never `NOW()`.
- Frontend: `../../../companion/src/components/Community.tsx`
  (`PlaceReminders`).
- Tests: `src/services/reminderConditions.test.js`.
