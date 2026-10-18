---
id: training-and-nutrition
title: Training program and nutrition
summary: I keep your weekly training program and your food log against daily targets, and read both alongside WHOOP and your scale.
where: Health page → Training Program card (Week N of N) and Nutrition card (Today)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [training program, program, workout plan, gym, leg day, hypertrophy, what am i doing today, tomorrow's workout, protein, calories, macros, carbs, nutrition, food log, what i ate, log food, barcode, scan food, food photo, tell athena, look up food, restaurant food, big mac, favorite foods, water, hydrate, target weight]
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

You can log food four ways: tap a starred favorite to log it again, tell me
in a few words what you ate ("Big Mac from McDonald's"), take a picture, or
type it in. When you tell me, I look the food up on the web — a restaurant's
or brand's own published nutrition where there is one — and log the calories
and macros for the amount you said. A picture of a plate gets my estimate of the food and
its calories and macros; a picture of a barcode is looked up in the Open Food
Facts database and one serving is logged. Every way but a favorite logs it straight
away and opens it ready for you to correct or remove, because a lookup or an
estimate can be off. Star any food in today's list (or tick "Save to favorites"
when typing one in) and it joins your favorites.

The Health page puts it together: my take on today from your WHOOP recovery,
then nutrition, the program's week, progress (weight, body fat, strength and
cardio minutes) and a wellness read, in that order. When you
ask me about your workout or what you've eaten, I can read all of it.

## Where to find it

Open the Health page from the sidebar (or Dashboards in the bottom bar on a phone).

- **Program:** the Training Program card → "Set up a program", or "Week N of
  N" to edit it. Each weekday gets a kind (gym, run, ride, sport, recovery,
  rest), a title, a focus, a detail and its exercises. Tap a day on the card
  to mark it done; tap again to mark it skipped, again to clear it.
  **View all activities** at the bottom of the card opens the Workouts page —
  every Whoop workout I've kept.
- **Food and water:** the Nutrition card → **Log food** opens a menu: your
  favorites (tap one to log a serving), **Tell Athena** (type what you ate,
  then Log it), **Take a picture** (the food or its
  barcode) or **Manual entry** (name, serving, calories, macros, water, and a
  "Save to favorites" box). "Today" lists what's logged: the star adds or
  removes a favorite, the pencil corrects an entry, ✕ removes it. The arrows
  beside the date page back through past days (never ahead of today) to fix,
  remove or add to them; **New record** opens the same menu — favorites, Tell Athena, Take a picture and Manual entry — logged to the day shown. Entries from
  a photo are tagged "Photo estimate", barcode lookups "Barcode", and what you
  told me "Told Athena".
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
- **"Couldn't make out a food or a barcode"** — retake it closer and in better
  light, or use Manual entry.
- **"Athena couldn't tell what food that was"** — name it another way (the
  dish and where it's from works best), or use Manual entry.
- **A barcode logged the wrong thing, or isn't found** — the product database
  is crowd-sourced and has gaps. If it isn't found I estimate from the photo
  instead; correct the entry with the pencil.

## Limits

- I can read your program, targets and food log in chat, but I can't change
  them from chat yet — logging food or editing the program happens on the
  Health page.
- I don't connect to MyFitnessPal, Cronometer or any food app. Nutrition is
  looked up for a barcode (Open Food Facts) and for what you tell me (a web
  search); when the search finds nothing I estimate typical values and say so.
  A plate is my estimate from the photo, not a weighed measurement.
- A barcode logs exactly one serving as the package defines it; change the
  numbers if you ate more.
- The photo isn't kept — only the entry it produced.
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
- Food by camera: `src/services/foodScan.js` — barcode read on the phone (`BarcodeDetector`, EAN/UPC) or by the "vision" task from the photo, check digit validated, looked up at `world.openfoodfacts.org/api/v2/product/:code`; otherwise the vision task estimates the plate. Values clamped to the entry bounds; the photo is never stored. `POST /dashboard/health/nutrition/scan` (8 MB body, listed in `server.js`)
- Tell Athena: `foodScan.describe` — `llm.search` (Google-grounded, frontier, 12 s cap; a failure falls back to an estimate) for the published nutrition, then the "json" task reads one entry's macros out of it; clamped like a scan, `source: "described"` (no migration: `source` is VARCHAR(16)). `POST /dashboard/health/nutrition/describe` (2 KB body, `{ text, eaten_on, today }`). Adults only via `requireAdultActor`.
- Favorites + corrections (migration `0074_nutrition_favorites`: `nutrition_favorite`, `nutrition_entry.source/serving/barcode`): `GET /dashboard/health/nutrition?date=&today=` (a past day's log), `PATCH /dashboard/health/nutrition/:uuid`, `POST /dashboard/health/favorites`, `DELETE /dashboard/health/favorites/:uuid`, `POST /dashboard/health/favorites/:uuid/log`. An entry is starred when a favorite has its label; correcting a starred entry updates the favorite.
- Tests: `src/services/healthPlan.test.js`, `src/services/foodScan.test.js`
- Notes: "done" from WHOOP is computed on read from `athena_workout` (via `workoutHistory.list`), never stored, so a deleted workout can't leave a stale tick. The client sends its local date (`today=`) because the server can't know the person's day. Hero image: `companion/public/assets/heart.png`.
