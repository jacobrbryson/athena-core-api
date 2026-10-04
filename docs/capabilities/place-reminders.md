---
id: place-reminders
title: Place reminders
summary: Tell me "next time I'm at Missy's, remind me to…" and I'll send it to your phone a couple of minutes after you get there.
where: ask me in conversation; see or remove them on the Community page → Place reminders
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [next time i'm at, next time im at, when i get to, when i'm at, whenever i'm at, every time i'm at, remind me when, remind me at, place reminder, place reminders, location reminder, when i arrive]
---

## What I can do

Ask me to remind you of something at a place — "next time I'm at Missy's,
remind me to bring back her casserole dish", or "every time I'm at church,
remind me to drop off the canned goods" — and I'll wait for you to get there.
A couple of minutes after you arrive, I send it to your phone as a
notification, and it's in our conversation too.

The place can be one of your points of interest on the Community page, or any
US street address. Before I set it I'll tell you which place I mean and its
address, so you can correct me if I've got the wrong Missy's. Then a card
shows exactly what I'll set — the place, its address and the words — and
nothing is set until you tap **Approve**. Tick **"Do this without asking me
each time"** on that card and from then on your "yes" in chat is enough.

"Next time" reminds you once. "Every time" or "whenever" reminds you on every
visit — once per visit, however long you stay.

Arriving during your quiet hours, or with Initiative switched off, doesn't
hold it back: you asked for it, so it comes when you get there.

## Where to find it

Just ask me in conversation. Everything I'm waiting to remind you of is on
the **Community** page (on the phone, Dashboard → Community card) under
**Place reminders**, with a **Remove** button on each and the ones that
already reached you underneath.

It needs three things switched on, once:

- **Location sharing** — the **⋯ menu (top right)** → **Initiative** →
  **location context**.
- **Location "all the time"** for Athena on your Android phone — the Community
  page's **Emergency alerts on this phone** section asks for it.
- **Reach me outside the app** in Initiative, so it can light up your phone.

## When it doesn't work

- **I got there and nothing came.** Check the three switches above — the
  Place reminders list says so when location sharing is off. The phone also
  needs the latest Athena app, and Android needs location turned on.
- **It came a few minutes late.** I wait until you've been there about two
  minutes so driving past doesn't count, and Android's location check can add
  a few more.
- **It never reached my phone.** It's still waiting in our conversation, and a
  "next time" reminder stays set for your next visit too, so it isn't lost.
- **"I couldn't find that address."** The lookup only knows US street
  addresses — give me the street and town, or add the place on the Community
  page first.

## Limits

- **Android only.** A browser or an iPhone can't tell me where you are.
- **About 300 metres.** I count you as there once you're within roughly two
  blocks of the address, because address lookups can be off by that much on
  rural roads; a neighbour's house may count as there.
- **Up to 50 waiting at once.**
- **I can't remove or change one for you.** Remove it on the Community page and
  ask me again.
- **Not time-based reminders.** "Remind me at 5pm" isn't this.
- **Your phone tells me where you are only when you arrive at one of these
  places** — never a trail of where you've been, and nothing at all while
  you have no place reminders set.
- **Children and Guardians don't get this.** It's for the account owner.

## Under the hood

**Model use:** none to detect or send. She proposes the reminder through the
action layer; the arrival check and the wording are code.

- Service: `../../src/services/placeReminders.js` — `resolvePlace` (POI by
  name/uuid, else Census geocode), `create`, `list`, `cancel`, `geofences`,
  `arrived` (server-side distance check, one fire per 8-hour visit, next-visit
  ones marked done only once a push was accepted), `promptBlock`.
- Action: `remind_at_place` in `../../src/services/actions/registry.js`
  (async `normalize`, which is why `../../src/services/actions/index.js` awaits it and passes the
  caller's `profileId` in ctx). Coordinates are never taken from the model.
- Routes: `../../src/routes/placeReminders.js` → `../../src/controllers/placeReminders.js`.
  `GET /api/v1/place-reminders`, `DELETE /api/v1/place-reminders/:uuid`
  (signed in); `GET /place-reminders/geofences`, `POST /place-reminders/arrived`
  (device token).
- Delivery: writes an `athena_nudge` row with `trigger_id = place_reminder`
  and pushes it via `push.deliverNudge`. Deliberately skips the Initiative
  opt-in and quiet hours (owner, 2026-10-04); still needs location sharing and
  `push_enabled`.
- Chat: `../../src/controllers/gemini.js` appends `placeReminders.promptBlock`
  (armed list, and a warning when location sharing is off).
- Schema: `../../db/migrations/0052_place_reminder.up.sql`.
- Frontend: `PlaceReminders` in `../../../companion/src/components/Community.tsx`,
  panel in `../../../companion/src/components/Dashboard.tsx` (CommunityPage).
- Android: `../../../native-runtime/AndroidCompanion~/AthenaDashboard.androidlib/java/com/orcwood/athena/dashboard/PlaceGeofences.java`
  (Play services geofencing, DWELL after 2 min, `INITIAL_TRIGGER_DWELL`;
  synced on resume/pause and by the persisted `PlaceGeofenceJob` every 30 min;
  re-registers only when the set or boot count changes), `PlaceGeofenceReceiver.java`.
- Tests: `../../src/services/placeReminders.test.js`.
- Notes: `status: partial` until the geofence path has fired on a real handset
  and migration 0052 is applied in production.
