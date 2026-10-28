---
id: research
title: Research
summary: I run small studies on your own data — bedroom temperature vs. sleep, thermostat setpoint vs. heating time, project pace — and say what I find.
where: Research (left navigation)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [research, study, studies, experiment, pattern, how fast do my projects, project pace, setpoint, heating hours, how long does the heat run, lower the thermostat, bedroom temperature]
---

## What I can do

I look for patterns in data I already have and say what I find, one question at
a time. Each study is a plain count of your own days or nights — no model is
guessing at the numbers — and each one says nothing until it has enough to mean
something, then tells you how sure I am.

Three studies today:

- **Bedroom & sleep** — which bedroom temperature goes with your best recovery.
  Needs Google Nest and WHOOP.
- **Setpoint & heating time** — how many hours a day the heat runs when the
  thermostat is set lower, from the thermostat's own readings. Needs Google
  Nest.
- **Project pace** — how many steps a week your projects really get, and the
  date each active project would finish at its own recent pace, plus any that
  have gone quiet. Needs a few finished project steps.

Every study shows how far its sample has come ("4 of 14 nights") rather than a
percentage, because a study keeps refining after its first finding. I don't
notify you when one finishes; it's there when you open Research or ask me.

## Where to find it

**Research** in the left navigation (on a phone, in the Dashboards menu). Each
study is a panel with its question, its progress and its finding. Bedroom &
sleep used to sit on Health; it lives here now.

## When it doesn't work

- **A study says it needs a source.** Link Google Nest and/or WHOOP under the
  ⋯ menu → **Connected apps**; for the bedroom study also choose the bedroom
  thermostat under **Property → Utilities → Thermostats → Use for sleep**.
- **A study is "gathering".** It's counting toward its minimum and will speak
  when it gets there; I only started keeping thermostat history when that
  shipped.
- **A study says it's unavailable.** One study failing doesn't affect the
  others; open Research again in a minute.

## Limits

- **Patterns, not causes.** I describe what lines up in your own data; I don't
  claim a temperature or a habit caused anything.
- **No energy figures.** Nest doesn't report energy, so the setpoint study
  measures hours of heating, not kilowatt-hours or dollars. Outdoor
  temperature isn't stored over time, so cold days can look like high
  setpoints; that study is always low confidence for now.
- **Project pace describes the last eight weeks.** It's not a forecast or a
  promise, and a project needs three finished steps of its own before I give
  it a date. Projects involving children are left out.
- **I only read.** Studies never change a thermostat or a project. If you want
  the bedroom at a temperature, ask and I'll offer a card to approve.
- **Adults only, and yours only.** Each study uses the signed-in person's own
  data.

## Under the hood

- Backend: `src/services/research/index.js` (registry and common result shape),
  `thermostatSetpoint.js`, `projectPace.js`; Bedroom & sleep stays in
  `src/services/sleepClimate.js` and is wrapped by the registry.
- Route: `GET /api/v1/research` (`src/controllers/research.js`,
  `src/routes/companion.js`); `?fresh=1` skips the studies' own caches.
- Frontend: `../../../companion/src/components/ResearchPage.tsx`,
  `../../../companion/src/api/research.ts`; nav entry `Research` in
  `Dashboard.tsx` (`dashboardSections`) and `dashboardRoutes.ts`.
- Tests: `src/services/research/research.test.js`.
- Notes: the old `GET /api/v1/dashboard/health/sleep-climate` route is kept for
  the chat prompt path and older app builds. Adding a study means adding one
  entry to `STUDIES` and a panel branch in `ResearchPage.tsx`; a study must be
  read-only, adult-only, and never enable initiative or notify on its own.
