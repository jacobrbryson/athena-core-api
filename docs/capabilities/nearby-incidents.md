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
  A call on I-77 or I-40 ("3700 N I77") is placed by its mile marker. If the
  street still can't be found, I ask a model for other ways to write it (the
  road's other name, a cross street) and use one only if the geocoder finds it
  in the same town; distances placed that way are "about".
  If I can't put it on a map at all, it's almost always somewhere else in the
  county, so I decide whether it could affect you before I interrupt. A
  traffic collision or medical call I can't place stays quiet unless something
  on your calendar in the next six hours, with a location, might take you past
  it. Anything else (a gas leak, a big fire, wires down, something at a school
  or hospital) gets a quick model check of whether it could reach your
  community or your route. If I think it might, I tell you why, without a
  distance. If any of those checks fails, I tell you anyway and say the check
  failed. Calls I keep quiet are still recorded, and I can tell you about them
  if you ask what's going on.
- **National Weather Service alerts** for each watched place, checked every 15
  minutes (every 5 for an hour after something comes up). A warning that is
  happening now is urgent; a watch is not.

Two or more calls at once, or any serious one, is urgent: it breaks quiet
hours, goes to every device you've set up, and I'll lead our conversation with
it. A single routine call waits for morning. When an urgent situation ends, I
say it's all clear.

On screen, the alert banner across the top shows every call with its distance
and a small map you can zoom and pan (the + and − buttons, pinch, scroll or
double-tap, drag to move; "Fit all" puts every call back in view) — the same
map is on an alert I raise in our conversation. "Got it" buries every call on it for good, on every device: I
won't show it again, bring it up in conversation, or mention it inside a later
alert. A new call opens the banner with just that call.

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
  If I recognise a call but can't place it, I only push it when it might
  affect you. Ask me "anything going on?" and I'll list the ones I kept quiet
  from the last three hours.
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

**Model use:** the situation assessment (headline, body, level), once per
change; the address rescue; and `watch.judgeUnplaced` (tell / keep quietly,
with a reason) for an unplaced call that isn't a Vehicle/Medical call with no
trip coming up. All three go through the normal access gate. Parsing, placing,
the floor, and "a failed check means tell" are rules. Trips come from
`googleCalendar.collectEvents` (not connected = no trips, any other error =
tell). Each unplaced decision is a row in `athena_incident_elsewhere`
(migration 0063); `promptBlock` lists the quiet ones from the last 3 h. Background calls are charged to `ATHENA_BACKGROUND_GOOGLE_ID`.

- Service: `../../src/services/pulsepoint/` — `watch.js` (situation, telling,
  weather rhythm, banner ack, prompt block), `phoneAlerts.js` (notification text
  → incident), `nws.js` (weather), `geo.js`, `geocode.js` (US Census geocoder),
  `interstates.js` (I-77/I-40 block number → point, from OSM exit positions),
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
  `athena_alert_ack_item` (each buried call/alert id, forever — 0054;
  `watch.visibleSituation` filters it out of every surface),
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
