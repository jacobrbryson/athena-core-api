---
id: family-health
title: Family health watch
summary: I keep track of who in the family is currently under the weather, so I stay aware of it and can remind the household about basic precautions.
where: Companion dashboard → Family → People & pets → Start a health watch (or a person's ⋯ → Health watch); each watch has its own page
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [sick, cough, cold, flu, fever, under the weather, feeling unwell, contagious, illness, symptom, health watch, check in, update every, medicine every, temperature every, dose, recurring check, tick off, progress report, end date]
---

## What I can do

I can log that someone in the family has a symptom — a name, what was
noticed, and how bad it is — and I keep that in mind for as long as it stays
active. I'll be aware of it in conversation and, where it fits naturally,
remind you and the rest of the household about ordinary precautions:
handwashing, not sharing cups or towels, wiping down shared surfaces, extra
rest. If you've turned on initiative, I may bring it up myself once a day
while it's still active, without you having to ask. I never diagnose and
never guess at a cause — I only track what you tell me.

You can also ask me for updates on a schedule — every 4, 6, 12 or 24 hours,
or any whole number of hours up to a week (a fever logged hourly, pain
medicine every 8 hours). When one is due I'll mention it in conversation, and
if initiative is on I'll ask for it myself. Logging the update moves the next
one on.

Each watch also has a page of its own, and that's where the detail lives:

- **Recurring checks** — "Check temperature" every 6 hours, "Tylenol 5 ml"
  every 12, any whole number of hours up to a week, each with a first time
  and an optional "until". A watch holds up to 12.
- **Coming up** — the next 48 hours of checks, overdue ones first. Tap
  **Done** (with an optional reading or dose) or **Skip** on the next one of
  each. Done sets the next one from when it was actually done, so a late dose
  never lands the next one too close; Skip moves on from when it was due.
- **A push when one's missed** — when a check comes due and nobody has ticked
  it off, the person who set it gets a phone push (and an in-app card) for
  that one check, at that time, even overnight — it's something you asked for,
  not me speaking up, so Initiative's switch and quiet hours don't hold it.
  Two checks due together are two pushes. Tapping it opens the watch's page.
- **Progress reports** — every update, every check ticked off or skipped, the
  start and the end, newest first, with who logged it. Log a new one there; a
  mistaken line can be removed.
- **Dates** — change when it started, set a planned end (checks stop after
  that day; the watch stays open until you end it), or correct the day an
  ended watch ended.

You can start a watch on yourself, not only on family.

You can do all of this from chat too: tell me "Thomas has a fever, check on
him every hour", "101.2 at 3pm, gave him Tylenol", or "Maya's feeling better"
and I'll put a card up to start the watch, log the update, or end it. Approve
it once, or give me a standing approval for health updates and I'll just log
them as you tell me.

## Where to find it

Companion dashboard → **Family** → **People & pets** (the Alerts tile opens
it): **Start a health watch** at the top asks who — **Me** first, then the
family, or any name — what you noticed and how bad, then opens the watch's
page (`/family/health/<id>`). Each person's **⋯** menu has **Health watch**
too. Anyone on a watch shows a red "Health watch" line under their name with
their next check — or what's due — and tapping it opens the page, where you
tick off checks, log updates, change dates, or end the watch ("Feeling
better"). Active cases also show on the Family card on the main dashboard.

The Family page's Family Health metric summarizes the active reports: Good
means no active health reports; Watch means mild symptoms have been reported;
Warning means at least one moderate report; Alert! means at least one severe
report. The highest reported severity wins. Underneath, I show how many
health watches are active and how many updates are due. An overdue update
doesn't change the reported severity. These are summaries of what you told
me, not a medical assessment. If reports can't be read, I show Unknown;
while the page first loads I show Loading.

## When it doesn't work

- **A report is missing after you add it** — refresh the dashboard; it reads
  from the same summary as the rest of the Family card.
- **I don't mention it in chat** — I only bring it up unprompted if
  initiative is turned on; otherwise ask me directly and I'll tell you what's
  active.
- **No push for a missed check** — push has to be switched on for your
  device (Notifications); the in-app card still appears. The push goes only
  to whoever set the check, not the whole family.
- **Checks stopped** — the watch's planned end has passed, or the check's own
  "until" did; move the date on its page.

## Limits

- From chat, an update goes on someone with an active watch only when I can
  tell which watch you mean — if two watches share a first name, or one
  person has two, I'll ask.
- Free-text only — I don't diagnose, look anything up medically, or track
  recovery beyond "still active" vs. "resolved".
- A person can have more than one watch at once (a cough and, separately, a
  rash) — each **Start a health watch** makes a new one. From chat I can
  only update one of those if you name its symptom; otherwise I'll ask, or
  you log it on that watch's page.
- I can't tick off a recurring check from chat — that's on the watch's page.
  Updates you give me in chat do land in its progress reports.
- One push per missed check; I don't repeat it while it stays overdue (the
  next one comes when the following check is due).
- Family-wide, not per-child — it doesn't distinguish who else in the
  household can see it.

## Under the hood

**Never sent to a model** beyond the précis in `familyHealth.promptBlock()`.

- Backend: `../../src/services/familyHealth.js`, `../../src/controllers/familyHealth.js`
- Routes: `POST /api/v1/dashboard/health/family` (body may carry `checkInHours`: 1–168, or null for none; omitted keeps the current cadence), `PATCH /api/v1/dashboard/health/family/:uuid/resolve`; read-only via the `familyHealth` source on `GET /api/v1/dashboard`. The page: `GET|PATCH /api/v1/dashboard/health/family/:uuid` (edit symptom, severity, `startedAt`, `endsOn`), `POST …/:uuid/entries`, `DELETE …/:uuid/entries/:entry`, `POST …/:uuid/checks`, `PATCH|DELETE …/:uuid/checks/:check`, `POST …/:uuid/checks/:check/mark` (`{ skip?, note?, at? }`)
- Recurring checks and their pushes: `../../src/services/familyHealthSchedules.js` — one waiting occurrence per check (`next_due_at`), claimed before it's pushed (nudge trigger id `health_check_due`, dedupe per check per due time), woken by a Cloud Task per due time via `reminderWakeups`, run by `src/jobs/reminders.js` with the hourly `src/jobs/incidents.js` as backstop. Not an initiative trigger — the person set it, like a time reminder
- Frontend: `../../../companion/src/components/HealthWatch.tsx` (start modal with the who-picker + chip), `../../../companion/src/components/HealthWatchPage.tsx` (the watch's page), `../../../companion/src/components/FamilyPeople.tsx` (⋯ menu), `../../../companion/src/components/Dashboard.tsx` (Family card), `../../../companion/src/api/dashboard.ts`
- Family Health metric: `../../../companion/src/components/familyHealthSummary.ts`,
  verified in `../../../companion/scripts/familyRoster.test.mjs`.
- Chat writes: the `log_health_update` action in `../../src/services/actions/registry.js` (propose → approve → `familyHealth.report`/`resolve`; standing-eligible; person resolved by `familyHealth.findActive`, never trusted from the model)
- Chat awareness: `familyHealth.promptBlock()`, wired into `../../src/controllers/gemini.js` alongside the nearby-incidents block (adult, non-guardian sessions only)
- Proactive nudge: `family_illness_precaution` trigger in `../../src/services/initiative/triggers.js` — no external connector required (`sources: []`), fires at most once per person per day while a status stays active; `family_health_check_in` (added 2026-10-11 on the owner's instruction) fires when a watch's check-in is due, one nudge naming every due case, keyed to the update each one follows
- Data: `family_health_entry` (history) and `family_health_schedule` (checks), plus `ends_on`/`time_zone` on the watch, from migration `0121_family_health_schedules`; `family_health_status` table (migration `0043_family_health_watch`), one active row per `(family_id, person_name)`; `check_in_hours` + `last_update_at` from migration `0062_family_health_check_in`; `family_id` is auto-provisioned via `familyHealth.ensureFamilyId()` for a companion-only adult who never ran the family/child setup flow
- Tests: `../../src/services/familyHealth.test.js` (cadence, validation, check-in trigger, prompt), `../../src/services/familyHealthSchedules.test.js` (upcoming, planned end in the watch's zone, done/skip, one push per occurrence, retry); also covered indirectly via `../../src/services/initiative/initiative.test.js` and `../../src/services/dashboard.test.js` (both mock this module rather than hitting a real family)
