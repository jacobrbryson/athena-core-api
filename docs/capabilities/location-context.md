---
id: location-context
title: Location Context
status: partial
summary: I can receive recent location context from your paired Android phone when you explicitly turn it on.
where: the ⋯ menu (top right) → Initiative → location context
surfaces: [companion]
audiences: [adult]
triggers: [location, where am I, nearby, near me, phone location, location sharing]
---

## What I can do

If you turn on **location context**, your paired Android phone can send me an occasional recent position while the Athena app is running. That can support future location-aware notifications.

## How to turn it on

Open the **⋯ menu in the top right** → **Initiative** → **location context**, then choose **Share phone location**. Android will ask for its own location permission the next time the phone app needs it.

## Where to find it

The **⋯ menu in the top right** → **Initiative** → **location context**. The switch is separate from the Initiative switch and asks you to allow location sharing before the phone reports anything.

## What I keep

I keep only recent samples for a short period. You can choose how often the phone sends one, and turning sharing off deletes the stored samples.

## When it doesn't work

If the phone says permission is needed, allow location for Athena in Android settings. If the status stays offline, open the app while the paired phone has a network connection so it can refresh the owner's setting.

## Limits

This first version reports while the Android app is running; it does not claim background location collection. Turning on location context does not turn on Initiative or create a notification by itself. The phone may also stop reporting when Android location services or its permission are off.

## Under the hood

- Companion control: `../../../companion/src/components/InitiativePanel.tsx`, `../../../companion/src/api/companion.ts`.
- API: `src/routes/location.js`, `src/controllers/location.js`, `src/services/location.js`.
- Schema: `db/migrations/0035_location_context.up.sql`.
- Android sender: the separate Unity companion project contains `LocationReporter.cs` and its API client.
