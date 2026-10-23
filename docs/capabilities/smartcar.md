---
id: smartcar
title: Your car, through Smartcar
summary: With your car linked through Smartcar, I can read its odometer, fuel or charge, and whether it's locked — and where it's parked, if you allow it.
where: ⋯ menu → Connected apps → Smartcar; each car on Property → Vehicles
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [smartcar, odometer, mileage, how many miles, gas, fuel, need gas, tank, charge, battery level, range, did i lock, is the car locked, locked the car, where did i park, where's my car, where is the car]
---

## What I can do

Once you link your car through Smartcar, I read it straight from the car's
own connected service (for a BMW, My BMW / ConnectedDrive):

- the **odometer**, in miles
- **fuel** or **battery** level and the range left
- whether it's **locked**
- **where it's parked** — only for a car you've turned location on for

Ask "how many miles are on the BMW?", "do I need gas?" or "did I lock the
car?". When a linked car matches one of your vehicles on Property → Vehicles
(by VIN, or because you picked it), its odometer keeps that vehicle's mileage
current — so what's due by mileage stays honest.

## Where to find it

**⋯ menu → Connected apps → Smartcar → Connect.** Smartcar asks you to sign in
to your car maker's account and choose which cars to share. Then, on
**Property → Vehicles**, each shared car shows its readings: pick which of
your vehicles it is if I didn't match it, and turn **Share location** on or
off for that car.

## When it doesn't work

- **No cars showed up.** On Smartcar's screen, make sure the car was ticked;
  connect again to change which cars are shared.
- **A reading is missing.** Not every car reports everything — an electric
  car has no fuel, and some makers don't report locks. What the car can't say
  I leave out rather than guess.
- **The readings are old.** I re-read a car at most every few hours so I don't
  keep waking it; ask again and I'll read it fresh if it's been a while. If
  the car maker's service is down, I say I'm showing the last readings.

## Limits

- **Read-only.** I can't lock, unlock, start, honk or open anything — the
  link doesn't even ask for those permissions.
- **Location only when you turn it on, per car.** Off means I don't read it
  or keep it; turning it off deletes what I had. I keep only the latest spot,
  not a trail.
- Disconnecting here stops my reads and forgets the link; to remove Smartcar's
  own access too, use Smartcar's account page or your car maker's app.
- Smartcar is a paid service for live cars; if the owner's plan runs out, the
  link stops answering.

## Under the hood

- Connector: `src/services/connectors/smartcar.js` (athena_smartcar_vehicle,
  migration 0091), on Smartcar's **v3** platform since 2026-10-23: one
  application token from the M2M client id/secret
  (`iam.smartcar.com/oauth2/token`, client_credentials, 1 h, cached), reads at
  `vehicle.api.smartcar.com/v3` with `sc-user-id`; cars from `/connections`,
  readings from `/vehicles/:id/signals/:code`. No command is ever sent.
- Connect: registry entry `smartcar` in `src/services/connectors/registry.js`
  builds the URL itself (`buildAuthorize`: `application_id`,
  `response_type=none`, state) and `completeLink` stores the returned
  `user_id` as an encrypted `api_key` credential (`oauth.js` begin/complete
  hooks). What a car shares is set under the dashboard's Vehicle Access.
- Routes: `GET /api/v1/projects/property/vehicles/smartcar`,
  `PATCH /api/v1/projects/property/vehicles/smartcar/:id`
  (`src/controllers/propertySmartcar.js`).
- Nightly `smartcar` step re-reads stale links; chat reads through
  `buildContext` / `get_car_status`.
- Owner setup: a Smartcar app with redirect
  `${PUBLIC_API_BASE_URL}/integrations/smartcar/callback`; Vehicle Access set
  to vehicle info, VIN, odometer, fuel, battery, lock status and location;
  secrets `SMARTCAR_CLIENT_ID` / `SMARTCAR_CLIENT_SECRET` (the M2M "client_…"
  pair) and `SMARTCAR_APPLICATION_ID` (Application details tab);
  `SMARTCAR_MODE=live` (or `simulated`).
- Tests: `src/services/connectors/smartcar.test.js`.
