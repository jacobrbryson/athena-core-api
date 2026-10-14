---
id: training-and-nutrition
title: Training program and nutrition
summary: I keep your weekly training program and your food log against daily targets, and read both alongside WHOOP and your scale.
where: Health page → Training Program card (Week N of N) and Nutrition card (Today)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [training program, program, workout plan, gym, leg day, hypertrophy, what am i doing today, tomorrow's workout, protein, calories, macros, carbs, nutrition, food log, what i ate, water, hydrate, target weight, today's plan]
---

## What I can do

I keep the training program you lay out — a weekly pattern like Gym A upper on
Monday, a 3–5 mile run on Thursday, soccer on Saturday — and how many weeks it
runs, so I know which week you're in and what's next. A session ticks itself
when WHOOP records a matching workout that day (lifting for a gym day, running
for a run, cycling for a ride), and you can tick or skip any day yourself.

I also keep your daily targets (calories, protein, carbs, fat, water, sleep
and a target weight range) and what you log eating and drinking, and show
today's totals against them as rings.

The Health page puts it together: my take on today from your WHOOP recovery,
today's plan (the session, or a lighter swap when your recovery is low, plus
hydration, food and a sleep goal), the program's week, nutrition, progress
(weight, body fat, strength and cardio minutes) and a wellness read. When you
ask me about your workout or what you've eaten, I can read all of it.

## Where to find it

Open the Health page from the sidebar (or the bottom bar on a phone).

- **Program:** the Training Program card → "Set up a program", or "Week N of
  N" to edit it. Each weekday gets a kind (gym, run, ride, sport, recovery,
  rest), a title, a focus, a detail and its exercises. Tap a day on the card
  to mark it done; tap again to mark it skipped, again to clear it.
- **Food and water:** the Nutrition card → "Today" or "Log food" to add what
  you ate (calories and macros), "+16 oz water" for a glass.
- **Targets:** the Nutrition card → "Targets" (or "Set a target" under
  Progress).

## When it doesn't work

- **"Training and nutrition aren't set up on this server yet"** — the
  database tables haven't been created on this server. The owner needs to run
  the migration; nothing you do in the app fixes it.
- **A workout didn't tick its day** — WHOOP's sport has to match the kind:
  "Weightlifting" or "Strength Trainer" for gym, "Running" for a run. Tap the
  day to mark it yourself.
- **The rings look empty** — I only count what you log. Nothing is read from a
  food app.

## Limits

- I can read your program, targets and food log in chat, but I can't change
  them from chat yet — logging food or editing the program happens on the
  Health page.
- I don't connect to MyFitnessPal, Cronometer or any food app, and I don't
  look up nutrition for a food — you enter the numbers.
- A program has no sets, reps or weights yet — sessions carry exercise names
  only. WHOOP doesn't record them either.
- One program at a time. Saving an edited program starts a new block; marks
  carry over to the same day and title.
- The wellness read (energy, immune readiness, sleep quality, stress) is
  arithmetic on WHOOP against your own week — a reason to pay attention, never
  a diagnosis. There's no mood tracking behind "Energy".
- Weight and body-fat history reaches back 90 days; strength and cardio come
  from recorded WHOOP workouts.

## Under the hood

**Never sent to a model.**

- Backend: `src/services/healthPlan.js` (program, marks, targets, food log, chat grounding `matches`/`buildContext`), `src/controllers/healthPlan.js`
- Migration: `db/migrations/0073_training_nutrition.up.sql` — `training_program`, `training_session`, `training_log`, `nutrition_target`, `nutrition_entry`
- Routes (`src/routes/companion.js`): `GET /api/v1/dashboard/health/plan?today=`, `PUT|DELETE /dashboard/health/program`, `PUT /dashboard/health/program/sessions/:uuid/mark`, `PUT /dashboard/health/targets`, `POST /dashboard/health/nutrition`, `DELETE /dashboard/health/nutrition/:uuid`
- Chat: `src/controllers/gemini.js` adds the `healthPlan.buildContext` block when `healthPlan.matches(message)`; adults only
- Frontend: `../../../companion/src/components/HealthPage.tsx` (+ `health.css`), `../../../companion/src/api/healthPlan.ts`; `Dashboard.tsx` HealthPage passes WHOOP/scale data through `SectionPage`'s `hero`
- Tests: `src/services/healthPlan.test.js`
- Notes: "done" from WHOOP is computed on read from `athena_workout` (via `workoutHistory.list`), never stored, so a deleted workout can't leave a stale tick. The client sends its local date (`today=`) because the server can't know the person's day. Hero image: `companion/public/assets/heart.png`.
