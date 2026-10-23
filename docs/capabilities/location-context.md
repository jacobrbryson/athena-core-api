---
id: location-context
title: Location Context
status: partial
summary: With location context on, I can ask your paired Android phone where it is — "Where am I?", "Where's my phone?" — and check that against your calendar.
where: the ⋯ menu (top right) → Initiative → location context
surfaces: [companion]
audiences: [adult]
triggers: [location, where am I, where are we, where's my phone, find my phone, my location, nearby, near me, phone location, location sharing]
---

## What I can do

If you turn on **location context**, your paired Android phone can send me an occasional recent position while the Athena app is running. That can support future location-aware notifications.

Ask **"Where am I?"** or **"Where's my phone?"** and I ask the phone for its position right then. I tell you the place — home, one of your saved places on the Community page, or the nearest named place on Google Maps — and how far that is from home. I also look at what's on your Google Calendar around now: if an event's location matches where the phone is, I'll say it looks like you're there ("looks like you're at Skylar's softball game — how's it going?"). If the phone doesn't answer, I tell you the last place it reported and how long ago.

You don't have to use those exact words — "what town is this?" or "what's around here?" works too, and on voice I'll say "let me check where your phone is" while I ask it.

## How to turn it on

Open the **⋯ menu in the top right** → **Initiative** → **location context**, then choose **Share phone location**. Android will ask for its own location permission the next time the phone app needs it.

## Where to find it

The **⋯ menu in the top right** → **Initiative** → **location context**. The switch is separate from the Initiative switch and asks you to allow location sharing before the phone reports anything.

## What I keep

I keep only recent samples for a short period. You can choose how often the phone sends one, and turning sharing off deletes the stored samples.

## When it doesn't work

If the phone says permission is needed, allow location for Athena in Android settings. If the status stays offline, open the app while the paired phone has a network connection so it can refresh the owner's setting.

## Limits

The phone doesn't track you. It sends a position only at a few moments: when you ask me where you are or how far somewhere is, when a PulsePoint call comes in, and when you arrive at a place you've set a place reminder for (see place-reminders.md). I only link you to a calendar event when the event has a location and it matches where the phone is — I won't guess an event from the place alone, and I can't know a game's score unless you tell me. Places are only as precise as the phone's fix, so in a crowded shopping center I may name the shop next door. Turning on location context does not turn on Initiative or create a notification by itself. The phone may also stop reporting when Android location services or its permission are off.

## Under the hood

- Companion control: `../../../companion/src/components/InitiativePanel.tsx`, `../../../companion/src/api/companion.ts`.
- "Where am I?": `src/services/whereabouts.js` (grounding block wired in `src/controllers/gemini.js`; the fresh fix comes from `travel.currentFix`, Places searchNearby on `GOOGLE_MAPS_API_KEY`, calendar via `connectors/googleCalendar.collectEvents`). Tests: `src/services/whereabouts.test.js`. Plain-speech questions reach it through the fast guess (`src/services/toolIntent.js`, source `location`, only when location context is on).
- API: `src/routes/location.js`, `src/controllers/location.js`, `src/services/location.js`.
- Schema: `db/migrations/0035_location_context.up.sql`.
- Android sender: the separate Unity companion project contains `LocationReporter.cs` and its API client.
