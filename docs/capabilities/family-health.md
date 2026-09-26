---
id: family-health
title: Family health watch
summary: I keep track of who in the family is currently under the weather, so I stay aware of it and can remind the household about basic precautions.
where: Companion dashboard → Family → Family health watch
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [sick, cough, cold, flu, fever, under the weather, feeling unwell, contagious, illness, symptom]
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

## Where to find it

Companion dashboard → **Family** → **Family health watch** panel: a short
form (who, what you noticed, how bad, optional notes) and a "Feeling
better?" button on anything currently active. Active cases also show on
the Family card on the main dashboard.

## When it doesn't work

- **A report is missing after you add it** — refresh the dashboard; it reads
  from the same summary as the rest of the Family card.
- **I don't mention it in chat** — I only bring it up unprompted if
  initiative is turned on; otherwise ask me directly and I'll tell you what's
  active.

## Limits

- Free-text only — I don't diagnose, look anything up medically, or track
  recovery beyond "still active" vs. "resolved".
- One active entry per person at a time; reporting again on the same person
  updates it rather than keeping a history of every report.
- Family-wide, not per-child — it doesn't distinguish who else in the
  household can see it.

## Under the hood

**Never sent to a model** beyond the précis in `familyHealth.promptBlock()`.

- Backend: `../../src/services/familyHealth.js`, `../../src/controllers/familyHealth.js`
- Routes: `POST /api/v1/dashboard/health/family`, `PATCH /api/v1/dashboard/health/family/:uuid/resolve`; read-only via the `familyHealth` source on `GET /api/v1/dashboard`
- Frontend: `../../../companion/src/components/Dashboard.tsx` (Family card + Family page panel), `../../../companion/src/api/dashboard.ts`
- Chat awareness: `familyHealth.promptBlock()`, wired into `../../src/controllers/gemini.js` alongside the nearby-incidents block (adult, non-guardian sessions only)
- Proactive nudge: `family_illness_precaution` trigger in `../../src/services/initiative/triggers.js` — no external connector required (`sources: []`), fires at most once per person per day while a status stays active
- Data: `family_health_status` table (migration `0043_family_health_watch`), one active row per `(family_id, person_name)`; `family_id` is auto-provisioned via `familyHealth.ensureFamilyId()` for a companion-only adult who never ran the family/child setup flow
- Tests: covered indirectly via `../../src/services/initiative/initiative.test.js` and `../../src/services/dashboard.test.js` (both mock this module rather than hitting a real family)
