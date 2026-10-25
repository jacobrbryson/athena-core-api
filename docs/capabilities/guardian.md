---
id: guardian
title: Guardian sweeps
summary: Each evening I check the garage doors and patio umbrella on camera and send a report; at 6 AM I say how the night went.
where: the left menu → Property → Security → Guardian
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [garage, garage door, left the garage open, is the garage closed, umbrella, patio umbrella, lights out, nightly sweep, guardian, sweep, storm, wind, gusts, lock up, check the house, evening report, morning report, all clear, good morning report, report time]
---

## What I can do

Once an authorized adult switches it on, I run a **nightly sweep** (9:00 PM
Eastern unless you change it). I take a fresh picture from each camera
assigned to a garage door and of the patio umbrella, and decide whether each is
closed or down, open or up, or that I can't tell.

Then I send the **evening report** to the household adults — every night,
even when all is clear:

- "All clear — I checked the garage door and the patio umbrella, and the
  weather looks peaceful tonight."
- "All clear — I checked the garage door and the patio umbrella, but there's
  possible snow from around 11 PM tonight."
- "ALERT: Your garage door is still open and the patio umbrella needs to be
  brought down before gusts up to 35 mph around 7 PM."

Anything wrong goes in that one message rather than a separate alert. An
umbrella left up on a calm night is mentioned but isn't an alert.

At **6:00 AM** (unless you change it) I send a **morning report** about the
night: "Good morning, I hope you slept well through the night." and then
either "All quiet — nothing happened overnight." or what did happen — a door
found open and when it was closed, something still open, a check that didn't
run, or a stranger the cameras saw. It wakes no camera; it reads what I
recorded overnight.

You can switch either report off, or change the sweep time and the morning
time, in Settings — or just ask me ("move the evening report to 9:30", "stop
the morning report"); I'll put the change on a card for you to approve.

With the evening report switched off, the sweep stays quiet when everything
is closed, and if a door looks open — even partly — I tell the household
adults straight away: "Athena here. The garage door appears to be open. I
checked the garage camera just now. Can someone close it?"

I never call a door closed from an old picture, a camera that didn't answer, or
a picture I couldn't read clearly. When that happens I take a fresh picture and
try again, and if I still can't tell, I say so: "I couldn't verify whether the
garage is closed because the camera isn't responding."

The **storm umbrella watch** reads the forecast and the National Weather
Service warnings for home. When thunderstorms or gusts over your limit (20 mph
unless you change it) are a few hours away, I check the backyard camera — at
any hour, not just at lights-out — and tell you if the umbrella is still up,
for example "There's gusts up to 35 mph around 7 PM, and the patio umbrella
still appears to be open. You may want to lower it before the wind picks up."

A problem stays open until I see it fixed. I look again every 15 minutes for
a garage door (30 for the umbrella) for a while. When a fresh picture shows it
closed, I mark it fixed and tell whoever I alerted. "Acknowledge" means someone
has seen it, not that it's fixed. You can also dismiss it with a reason. If no
one acknowledges an urgent alert within 30 minutes, I send one reminder. I
never send the same alert twice for the same problem.

## Where to find it

The left menu → Property → Security → the **Guardian** card at the top. It
shows the overall status, the last sweep, the garage and umbrella results,
the weather, the cameras, anything that needs attention (with the picture
that showed it), and recent activity. Use **Run sweep now** to check
immediately, **Recheck**, **Acknowledge**, **Who's on it** or **Dismiss** on a
problem, and **Test** to try it out with made-up results — a test never sends
an alert.

**Settings** turns each sweep on or off and sets the sweep time, the evening
and morning reports (on/off and the morning time), the garage doors (name, camera and where the door is in the picture), the umbrella,
the wind and storm limits, quiet hours for the umbrella, who is told, the
reminder delay, "observe only" (record without alerting) and simulation mode.
Only adults authorized for household security can see it or be told.

## When it doesn't work

- **"Couldn't verify" every night.** The camera bridge at home may be off, or
  the battery camera asleep or busy with another camera. Check that Security
  shows the bridge as Ready and that "Get fresh image" works for that camera.
- **No alert arrived.** Alerts go to your phone like my other alerts, so phone
  notifications need to be on for you (Initiative settings). Without them the
  alert still appears in the app; the Guardian card shows "in the app only".
- **The sweep was reported as missed.** The check didn't run at its time —
  usually the cameras weren't reachable from the cloud. I report a missed
  sweep instead of staying silent.

## Limits

- I can only see. I can't close a garage door, lock anything or change any
  device; that would always need a person's approval.
- My read of a picture is a judgement, not a sensor. Night, glare, rain on the
  lens and odd angles make it unreliable, which is why unclear means "I can't
  tell", never "it's fine". No garage-door sensor is connected yet.
- Each check wakes a battery camera, so I don't check more often than the
  sweep, the weather and the rechecks need.
- I keep the picture only when it shows a problem; a closed door's picture is
  thrown away. Problem pictures are deleted 30 days after the problem closes
  unless someone stars them.
- I can't yet answer "is the garage closed?" in chat from the sweep's results;
  the Guardian card and the evening report have them. Umbrella alerts found
  during quiet hours wait for morning unless the weather is under six hours
  away; garage alerts at the sweep always go out.
- From chat I can only change the report times and switch the reports on or
  off, always on a card you approve. Turning the sweep off, cameras, weather
  limits and who is told are only in Settings.
- The reports go to the same people as the alerts. If phone notifications are
  off for someone, the report still appears in the app for them.

## Under the hood

**Never sent to a model.**

- Design: `docs/architecture/guardian-engine.md`
- Engine: `src/services/guardianEngine/` — `index.js` (plan/runDue/runNow/incidents/notify/overview), `protocols.js` (nightly_sweep, storm_umbrella, config cleaning, zone time), `checks.js` (garage_door, patio_umbrella, wording), `observe.js` (fresh frame → vision → sensor fusion), `policy.js` (autonomy levels 0–4), `weatherRisk.js` (NWS hourly + alerts), `states.js`, `store.js` (SQL), `dispatch.js` (job → service, Cloud Tasks)
- Bridge client shared with the Security tab: `src/services/eufyBridge.js`
- Routes: `GET/PUT/POST /api/v1/projects/property/security/guardian…` (`src/controllers/guardian.js`); `POST /internal/guardian/dispatch` (Google ID token from an allowed service account)
- Job: `src/jobs/incidents.js` `guardianPass()` plans and dispatches; only the core service can reach the bridge
- Migration: `db/migrations/0093_guardian_engine.up.sql` (`athena_guard_*`)
- Frontend: `../../../companion/src/components/SecurityGuardian.tsx`, `../../../companion/src/api/propertyGuardian.ts`
- Tests: `src/services/guardianEngine/guardianEngine.test.js` (in-memory store twin `memoryStore.testkit.js`), `src/controllers/guardian.test.js`
- Reports: `src/services/guardianEngine/reports.js` (wording, pure), `weatherRisk.tonight()`; the evening report rides the `schedule` run (problems collected via `defer` and sent once by `sendReport`), the morning report is a `trigger_kind = 'report'` run (`morning:<date>`) executed by the planner itself. Chat action `set_guardian_reports` in `src/services/actions/registry.js` (test `src/services/actions/guardianReports.test.js`).
- Notes: alerts are nudges (`trigger_id = 'guardian'`) pushed with `push.deliverNudge`, not Initiative triggers. Test runs use `sim:`-prefixed incident keys and close at the end so they can never swallow a real alert.
