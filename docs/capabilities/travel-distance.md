---
id: travel-distance
title: Travel Distance
summary: Ask how far a place is and I'll look up the real drive on Google Maps, from home or from where your phone is right now.
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [how far, how far away, distance to, drive time, how long to get to, how long does it take to get, how long of a drive, from home, from here, current location]
---

## What I can do

Ask "How far away is Statesville Soccer Complex?" and I find the place on Google Maps and work out the drive: miles and minutes, with traffic as it is right now. I look for the one near you, so "the soccer complex" means your local one.

I can measure from **home** (the Home point of interest on your Community page) or from **where your phone is right now**. If you're away from home and didn't say which, I'll ask "From home, or from where you are now?" and give you that one. If you're at home, or I can't get your phone's position, I just answer from home. You can also say it up front: "...from here" or "...from home."

## Where to find it

Just ask me in conversation. There's nothing to switch on for distances from home beyond having **Home** saved on the **Community** page. Measuring from where you are needs **location sharing** on (⋯ menu, top right → Initiative → location context) and the Athena app on your paired Android phone.

## When it doesn't work

- **"I have nothing to measure from"**: save Home on the Community page, or turn on location sharing.
- **I only answer from home even though you're out**: your phone didn't send its position within a few seconds. Check that location sharing is on and that Android lets Athena use location. The phone app needs to be the version from October 2026 or later.
- **I can't find the place**: give me the town or the street address.

## Limits

- Driving only. No walking, transit, or cycling times, and no turn-by-turn directions.
- I can't save places to your Google Maps lists (Travel plans, Want to go, and so on). Google doesn't let any app write to them. I can give you the place's Google Maps link, and you can save it from there.
- Asking your phone where it is takes a few seconds, so a distance question can take a moment longer than usual. I ask the phone only when you ask me something like this, and only with location sharing on.
- I remember which place you asked about for about fifteen minutes, long enough for you to answer "from home or from here?". After that, ask again.

## Under the hood

- Backend: `src/services/travel.js` (Places Text Search (New) + Routes `computeRoutes`, key `GOOGLE_MAPS_API_KEY` via `services/secrets`, runtime from Secret Manager), wired as a grounding block in `src/controllers/gemini.js`.
- Phone fix: `push.requestLocation()` sends a silent FCM data message `{kind: "locate"}` (`fcm.send({silent:true})`, no title/body so no app version draws it); only when `athena_location_pref.enabled`. The Android app (`AthenaPushService` → `LocationReporter`) posts one sample to `POST /location/sample`; travel.js polls for a sample *received* since the request (≤ 9 s).
- Follow-up state ("from home or here?") is in process memory per profile, 15 min, single use — a different Cloud Run instance won't have it, and she'll just ask again.
- Tests: `src/services/travel.test.js`, `src/services/push/fcm.test.js`.
- Status is `partial` until the Maps key exists and the locate-capable APK is on the phone.
