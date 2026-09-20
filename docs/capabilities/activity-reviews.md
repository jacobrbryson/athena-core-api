---
id: activity-reviews
title: Understanding WHOOP activities in context
summary: With activity reviews enabled, I can compare WHOOP activities with your calendar, memories and corrections, and keep a separate, evidence-backed interpretation.
where: the ⋯ menu → Connected apps → Whoop → Activity reviews
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [activity reviews, workout, workouts, whoop activity, coaching, wrong activity, ultimate frisbee, activity correction]
---

## What I can do

WHOOP's activity label may not describe what you were really doing. If you turn
on activity reviews, I compare its exact times with your connected calendar and
relevant memories. I keep WHOOP's original label alongside my interpretation,
explain the evidence, and show when I am uncertain. A scheduled appointment is
not proof that you attended it.

You can choose **That's right** or **Correct this**, and optionally explain the
context for next time. Your correction can inform later reviews; it is not a
rule that blindly relabels every similar activity. Confirmed interpretations
and tentative interpretations remain distinct when we discuss your workouts.

## Where to find it

The **⋯ menu → Connected apps → Whoop → Activity reviews**. Connect one WHOOP
account and one Google Calendar account, then turn on **Review my WHOOP activities
in context**. This is separate from Initiative and does not enable notifications.

The panel shows the latest thirty reviewed activities, original labels,
interpretations, cited evidence, queue counts and processing errors. **Recheck
activities** queues another check; **Refresh** reads the current results.
**Forget reviews and corrections** deletes this feature's saved data and turns
it off. Pausing with the switch keeps saved reviews but stops processing.

## When it doesn't work

- **No completed check yet:** deployment needs the activity worker scheduled and
  the database migration applied. Enabling the switch alone does not run it.
- **An update is waiting:** a source or model failed. Work stays queued and is
  retried; a server restart does not erase it.
- **Connect Google Calendar:** this first version requires both connections and
  health-data consent. A disconnected or changed account blocks processing.
- **Supporting information changed:** a saved memory was changed/forgotten or
  the calendar account changed. The old inference is hidden until rechecked.
- **Too much calendar data:** an incomplete evidence read is retried and reported,
  rather than being treated as an empty calendar.

## Limits

- I cannot edit WHOOP. My interpretation is stored only in Athena.
- This implementation needs deployment, migration, webhook registration and a
  scheduled worker before it can run against live accounts; live acceptance is pending.
- Hourly catch-up covers the last seven days, with pagination. Older activities
  are processed if WHOOP sends their webhook, but this is not a full-history sync.
- Recent known activities are also revisited to notice source removals and changed
  calendar context. Results are timestamped snapshots, not continuous proof.
- Context includes up to fifty ranked facts and thirty recent correction records.
- Only the owner sees these private reviews. No family sharing or notifications
  are added by enabling this feature.
- Source and context snapshots are encrypted at rest and retained until you use
  Forget. Source disconnection blocks access/processing but does not itself delete
  saved reviews. Forget remains available in the panel.
- A correction is made in the panel. Saying something in chat may update ordinary
  memory, but does not directly confirm a specific review.

## Under the hood

- Ingress: `src/controllers/whoopWebhook.js`, mounted before JSON parsing in
  `src/server.js`; public proxy route `/api/v1/webhooks/whoop`, raw-body HMAC.
- Storage and lease fencing: `src/services/attention/store.js`.
- Generic interpretation contract: `src/services/attention/interpret.js`.
- WHOOP source/context: `src/services/attention/whoop.js`.
- Worker: `src/services/attention/worker.js`, `src/jobs/attention.js`.
- API and chat grounding: `src/services/attention/index.js`, `src/routes/attention.js`.
- UI: `../../../companion/src/components/WhoopActivityReviews.tsx`.
- Migration: `db/migrations/0036_attention.up.sql`.
- Setup and acceptance: `docs/architecture/activity-reviews.md`.
