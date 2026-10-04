---
id: nearby-incidents
title: Nearby emergencies
summary: I tell you when there's a 911 call or a serious weather warning close to the places you've asked me to watch.
where: Athena's notifications (in-app, phone, browser, text), the alert banner, in conversation; places on the Community page → Points of interest
status: live
surfaces: [companion]
audiences: [adult]
triggers: [emergency, fire, sirens, what happened, police, ambulance, dispatch, scanner, pulsepoint, nearby, down the street, what was that, weather warning, tornado, storm]
---

## What I can do

When something happens near home — a structure fire, a tree down across the
road, a tornado warning — I tell you: what it is, where, and how far away. Two
sources feed this:

- **911 calls, from the PulsePoint Respond app on your phone.** When PulsePoint
  notifies you about a call, the Athena app passes that notification to me and
  clears PulsePoint's own notification from the tray, so the alert you get is
  mine; I work out where it is, and if it's within range of a watched place —
  or within three miles of where your phone is, if you've allowed location — I
  send you a push myself. Medical calls are included; only drills, standby
  and unit moves are left out. When the call doesn't name a town, I look the
  street up in the town your phone is in first, then your saved places' towns.
  If I can't put it on a map at all, I still tell you what PulsePoint said —
  just without a distance.
- **National Weather Service alerts** for each watched place, checked every 15
  minutes (every 5 for an hour after something comes up). A warning that is
  happening now is urgent; a watch is not.

Two or more calls at once, or any serious one, is urgent: it breaks quiet
hours, goes to every device you've set up, and I'll lead our conversation with
it. A single routine call waits for morning. When an urgent situation ends, I
say it's all clear.

On screen, the alert banner across the top shows every call with its distance
and a small map. "Got it" shrinks it to a slim bar, and I remember that on the
server — on every device — until something new happens, which opens it again.

## Where to find it

The **Community** page → **Points of interest**: add home, family homes, your
church or anywhere else by street address or your current location, each with
its own radius, and pause any of them. Further down the same page, **Emergency
alerts on this phone** offers notification access so the Athena app can read
PulsePoint Respond's notifications; that's granted in Android settings and
you can revoke it there. PulsePoint Respond has to be installed and set to
notify you about the call types you care about. It also has:

- **Make PulsePoint's own alerts silent** — opens PulsePoint's notification
  settings; choose Silent (not Off, which would hide them from me too).
- **Use this phone's location** — lets me check each call against where the
  phone is at that moment ("Allow all the time", because alerts arrive while
  I'm closed). Only taken when a call comes in, never on a schedule.
- **Test PulsePoint alert** and **Test weather alert** — a made-up call or
  warning at one of your places, sent through the same steps a real one takes
  and pushed to your devices, with each step ticked or crossed so you can see
  where it broke. Nothing is saved and it never appears in the banner.

## When it doesn't work

- **No 911 calls ever arrive:** check that PulsePoint Respond is installed and
  notifying you, and that notification access for Athena is on (Community →
  Emergency alerts on this phone shows its state). If Android says "Restricted setting" when you try to switch
  it on, open Athena's app info → ⋮ → Allow restricted settings, then try again
  — Android does that for apps not installed from the Play Store. Then press
  Test PulsePoint alert.
- **I still hear PulsePoint's own sound:** I clear its notification the moment
  I read it, but only PulsePoint's own notification setting (Silent) can stop
  the sound that plays before that.
- **A call was on PulsePoint but I said nothing:** it was outside every
  watched radius (three miles of where your phone is, if location is on), its
  call type wasn't one I recognise, or it was a drill, standby or unit move.
  A call I recognise but can't place still reaches you, marked as unplaced.
- **The weather service can't be read:** I'll tell you once, and I'll say so if
  you ask about the weather.

## Limits

- I no longer read PulsePoint's website directly — they block automated
  readers — so I only see the calls PulsePoint's own app notifies you about.
- A phone-reported call has no "it's over" signal; it drops off after three
  hours.
- "Near me" needs location allowed "all the time" in the Athena app; without
  it, calls are only checked against your saved places. A position older than
  45 minutes is not used.
- Texts may not be delivered: carriers are rejecting them until the sending
  number is registered.

## Under the hood

**Model use:** only the situation assessment (headline, body, level), once per
change, through the normal access gate; parsing, placing and the floor are
rules. Background calls are charged to `ATHENA_BACKGROUND_GOOGLE_ID`.

- Service: `../../src/services/pulsepoint/` — `watch.js` (situation, telling,
  weather rhythm, banner ack, prompt block), `phoneAlerts.js` (notification text
  → incident), `nws.js` (weather), `geo.js`, `geocode.js` (US Census geocoder),
  `calltypes.js` + `calltypes.json`.
- Job: `../../src/jobs/incidents.js` (`athena-incidents`, scheduler every 5 min;
  the rhythm lives in `watch.js`). It reads the weather service only and
  retires expired phone calls.
- Routes: `GET /api/v1/dashboard/alert`, `POST /api/v1/dashboard/alert/ack`,
  `POST /api/v1/dashboard/incidents/phone-alert` (device token; `test: true`
  runs the test), `POST /api/v1/dashboard/incidents/test` (`{kind}`, session),
  places CRUD. `watch.testAlert` writes no nudge and no situation.
- Android: `native-runtime/AndroidCompanion~/AthenaDashboard.androidlib` —
  `PulsePointListener.java` (reads/clears PulsePoint, sweeps the tray on
  connect), `LocationReporter.java` (one position per call, to
  `POST /location/sample`, which enforces `athena_location_pref`).
- Tables: `athena_incident_situation` (the one judgement every surface reads),
  `athena_incident_source` (weather health), `athena_alert_ack` (the banner's
  "Got it", migration `../../db/migrations/0044_alert_ack.up.sql`),
  `athena_watch_place`.
- Banner: `../../../companion/src/components/EmergencyBanner.tsx`; places:
  `../../../companion/src/components/Community.tsx` (points of interest, on the
  Community page since 2026-10-04 — the Watched places drawer is gone); phone
  setup and test alerts: `../../../companion/src/components/EmergencyAlertSetup.tsx`.
- Tests: `../../src/services/pulsepoint/pulsepoint.test.js` — pure, no network;
  `testAlert.test.js` — the test path, mocked DB/push/geocoder.
- History: the web board (`api.pulsepoint.org`, agency `EMS1681`) was polled
  until PulsePoint turned on AWS WAF bot protection on 2026-09-22. It was never
  to be worked around, and the owner removed the poller, its health row and the
  "partly offline" banner on 2026-09-26. Do not reintroduce a web-board reader.
- The floor: two or more calls or any serious one is urgent; the model may raise
  but never lower. With three calls or fewer the answer must name every one.
- "Could not read" is never "all clear": weather alerts are carried forward
  when the service fails.
- PulsePoint's `alertable` flag is not the gate (it marks Tree Down as
  non-alertable); it only feeds the level.
