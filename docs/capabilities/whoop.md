---
id: whoop
title: Whoop
summary: Once connected, I can see your recovery, strain and sleep — so "why am I wrecked today?" has a real answer.
where: the ⋯ menu (top right) → Connected apps → Whoop → Connect
status: live
surfaces: [companion]
audiences: [adult]
triggers: [whoop, workout, workouts, lifting, weightlifting, gym, recovery, recovered, strain, sleep, slept, hrv, heart rate variability, resting heart rate, readiness, rested, tired, fatigue]
---

## What I can do

For activity labels that do not match real life, **Activity reviews** in the
Whoop row can compare workouts with calendar entries and memories. You can
inspect and correct my interpretation; WHOOP itself stays unchanged. This
separate opt-in runs whenever Whoop reports a workout. See
[activity-reviews.md](activity-reviews.md).

With Whoop connected I can see roughly the last week of your recovery scores,
daily strain, sleep, and the numbers underneath them — HRV, resting heart rate,
how long you actually slept versus how long you needed.

I also keep a history of your Whoop workouts — every session from the day it
was recorded, kept even after Whoop's own one-week window has scrolled past —
so "how often have I lifted since summer?" or "how hard were my gym sessions
last month?" has an answer. For each workout I have the sport, when and how
long, strain, average and peak heart rate, energy burned, and how many minutes
you spent in each heart-rate zone.

You can see that history yourself on **Health & Performance** → **Workouts**:
sessions per week or month, time in each heart-rate zone, and each session
with its time, strain, heart rate and energy. Filter by sport — **Lifting**
groups weightlifting, Strength Trainer and powerlifting — and by range (3
months, 6 months, a year, or everything).

That means when you say you're exhausted, I can look rather than sympathise
blindly: two bad nights and a red recovery is a different conversation from
feeling flat on a good one.

## Where to find it

The **⋯ menu in the top right corner** → **Connected apps** → the **Whoop** row
→ **Connect**.

Whoop is health data, so the first time you'll be asked to agree to sharing
health data with me before Whoop's own approval page opens. **Disconnect** in
the same row deletes the credential.

## When it doesn't work

- **"Not connected."** Never linked, or Whoop revoked the link — reconnect from
  the same row.
- **Connected but thin data.** If the strap hasn't synced with Whoop's own app
  recently, I'm reading what they have, which may be behind. Open Whoop on your
  phone and let it sync.
- **Today's score isn't showing yet.** I keep what I read from Whoop for a few
  hours, because recovery and sleep change once a day. When Whoop tells me a
  new score is in, I drop that copy straight away; if that notification hasn't
  arrived, the new score shows up within six hours (strain within the hour).
- **Something failed.** I'll tell you what Whoop's error actually said rather
  than inventing a reason your recovery is missing.

## Limits

- Read-only, and I can't set anything or log a workout.
- Recovery and sleep go about a week back. Workouts go back as far as I've
  recorded them, but only for an adult whose family has agreed to share health
  data with me.
- Whoop tells me nothing about what happened inside a lifting session: no
  exercises, sets, reps or weights. I see the heart-rate side only — strain,
  heart rate and time in each zone.
- Disconnecting Whoop stops new workouts being recorded; the history already
  kept stays, and there is no button to clear it yet.
- I'm not a doctor and this isn't medical advice — it's your own data, read
  back to you.
- One Whoop account.
- The health card's blood oxygen warning compares against your own recent
  nights, not a fixed number — WHOOP measures it asleep, where low-to-mid 90s
  is normal for many people. It warns when a night sits about three points
  under your usual, or under 90%.

## Under the hood

- Connector: `src/services/connectors/whoop.js` — recovery, sleep, workouts and
  cycles (`days = 7`, `MAX_LIMIT = 25`, Whoop's own ceiling), formatted into a
  prompt block, plus a tool path.
- Descriptor: `whoop` in `src/services/connectors/registry.js` —
  `consentType: "health_data"`, `rotatesRefreshToken` (a refresh returns a NEW
  refresh token which MUST be persisted or the link dies), `identifyAsync` via
  `/v2/user/profile/basic`.
- Grounding: `src/services/connectors/context.js`.
- Cache: reads live in the shared read cache for 6 h (recovery, sleep, profile)
  or 1 h (cycles, workouts) — `CACHE_TTL_MS` in `src/services/connectors/http.js`. Signed
  `recovery.*`, `sleep.*` and `workout.*` webhooks call
  `whoop.invalidateAccount()` from `src/controllers/whoopWebhook.js`.
- Health card verdict: `readinessOf()` in `../../../companion/src/components/Dashboard.tsx`.
- Workouts panel: `GET /api/v1/workouts?days=` (`src/routes/workouts.js`,
  adult only, own rows, up to 2000) → `../../../companion/src/components/Workouts.tsx`.
- Workout history: `athena_workout` (migration 0067) via
  `src/services/workoutHistory.js` — upserted from `listWorkouts()`, the signed
  `workout.*` webhook (`fromWebhook` reads the workout back; a 404 sets
  `deleted_at`), and the activity-review sync page. Gated on adult +
  `health_data` consent. Tool `get_workout_history` (days ≤ 3650, sport
  filter). Backfill: `node scripts/backfillWorkouts.js <profileId> [--dry-run]`.
- Tests: `src/services/connectors/connectors.test.js`,
  `src/services/workoutHistory.test.js`, `src/controllers/whoopWebhook.test.js`.
