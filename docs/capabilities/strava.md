---
id: strava
title: Strava
summary: Once connected, I can see your recent activities — runs, rides, swims — with distance, pace and elevation.
where: the ⋯ menu (top right) → Connected apps → Strava → Connect
status: live
surfaces: [companion]
audiences: [adult]
triggers: [strava, workout, workouts, run, ran, running, ride, rode, riding, cycling, swim, swam, training, exercise, mileage, pace, elevation, activity, activities]
---

## What I can do

With Strava connected I can see your activities from roughly the last two
weeks — what you did, when, how far, how long, your pace and the elevation —
and talk about them properly: whether this week was lighter than last, how the
long run went, what you've actually been doing.

I only look when what you said is plausibly about training.

## Where to find it

The **⋯ menu in the top right corner** → **Connected apps** → the **Strava**
row → **Connect**.

Strava is health data, so the first time you'll be asked to agree to sharing
health data with me. After that, Strava's own page opens and asks you to
approve read access. **Disconnect** in the same row deletes the credential.

## When it doesn't work

- **"Not connected."** The link was never made, or Strava revoked it — check
  Strava's own settings under the apps you've authorized, then reconnect.
- **Connected but I see nothing.** If nothing was recorded in the last two
  weeks, there is genuinely nothing for me to see. Activities you've set to
  private may also be out of reach.
- **Something failed.** I'm handed Strava's own error and I'll tell you what it
  actually said rather than pretending you had a quiet fortnight.

## Limits

- Read-only. I can't upload, edit, or kudos anything.
- About two weeks back, and at most 30 activities — not your whole history.
- Recent activity only, not segments, routes, gear or your social feed.
- One Strava account.

## Under the hood

- Connector: `src/services/connectors/strava.js` — `matches()` gate,
  `listActivities()` (`days = 14`, `MAX_ACTIVITIES = 30`, epoch-seconds
  `after` filter), normalize/summarize into a prompt block, plus a tool path.
- Descriptor: `strava` in `src/services/connectors/registry.js` —
  `consentType: "health_data"`, comma scope separator.
- Grounding: `src/services/connectors/context.js`.
- Tests: `src/services/connectors/connectors.test.js`.
