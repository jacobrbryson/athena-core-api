---
id: whoop
title: Whoop
summary: Once connected, I can see your recovery, strain and sleep — so "why am I wrecked today?" has a real answer.
where: the ⋯ menu (top right) → Connected apps → Whoop → Connect
status: live
surfaces: [companion]
audiences: [adult]
triggers: [whoop, recovery, recovered, strain, sleep, slept, hrv, heart rate variability, resting heart rate, readiness, rested, tired, fatigue]
---

## What I can do

With Whoop connected I can see roughly the last week of your recovery scores,
daily strain, sleep, and the numbers underneath them — HRV, resting heart rate,
how long you actually slept versus how long you needed.

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
- **Something failed.** I'll tell you what Whoop's error actually said rather
  than inventing a reason your recovery is missing.

## Limits

- Read-only, and I can't set anything or log a workout.
- About a week back, not months of history or long-term trends.
- I'm not a doctor and this isn't medical advice — it's your own data, read
  back to you.
- One Whoop account.

## Under the hood

- Connector: `src/services/connectors/whoop.js` — recovery, sleep, workouts and
  cycles (`days = 7`, `MAX_LIMIT = 25`, Whoop's own ceiling), formatted into a
  prompt block, plus a tool path.
- Descriptor: `whoop` in `src/services/connectors/registry.js` —
  `consentType: "health_data"`, `rotatesRefreshToken` (a refresh returns a NEW
  refresh token which MUST be persisted or the link dies), `identifyAsync` via
  `/v2/user/profile/basic`.
- Grounding: `src/services/connectors/context.js`.
- Tests: `src/services/connectors/connectors.test.js`.
