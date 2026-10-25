---
id: vehicles
title: Vehicles
summary: I track your vehicles' registration, inspection, mileage, due dates, service and NHTSA recalls, and put a close deadline across the top of Home.
where: the left menu → Property → the Vehicles tab → Add vehicle
status: live
surfaces: [companion]
audiences: [adult]
triggers: [recall, recalls, safety recall, nhtsa, vehicle, vehicles, my car, our cars, truck, van, oil change, registration, registration number, registration renewal, renew registration, tags, state inspection, inspection, acknowledge recall, recall repaired, odometer, mileage, tire rotation, service history, car maintenance, vin, license plate, car insurance]
---

## What I can do

Vehicles live under your property, on the Property page's **Vehicles** tab.
For each one you can save what you call it ("The BMW"), its year, make,
model, color, plate and VIN, its odometer reading, and a photo. I show each
vehicle as a card with its mileage and the most pressing thing coming due.

**Registration & inspection** has its own section in the vehicle form: the
state it's registered in, the registration number from the card, when the
registration expires, when inspection is due, and where it's inspected. A
vehicle card with no registration or inspection date says so, so it's never
silently missing.

You can also add when insurance renews and the next service by date or by
mileage. In a vehicle's details, **Coming due** lists them soonest first:
red when overdue, yellow within 30 days (or 500 miles of the next service),
green when further out. A registration, inspection or insurance date that's
close has **Renewed?** — it fills in the same date a year later, which you can
change, and saves it.

**On Home.** When a registration, inspection or insurance date is overdue or
within two weeks, a banner goes across the top of the main dashboard, under
any emergency alert — amber, turning red inside a week or once overdue — with
every such date on every vehicle, **Open** (the vehicle's details) and **Help
me get it done** (a conversation with me about renewing it). It has no "Got
it": it goes away when the date is renewed or changed. Service dates don't put
it up.

**Service history** is a dated log of work done — an oil change, new tires, a
repair — with the mileage and the shop if you like. Logging service with a
mileage higher than the odometer on file updates the odometer too.

**Safety recalls.** For each vehicle I look up NHTSA's public recall list —
by its VIN when you've saved one, otherwise its year, make and model — when
you add it and again every night. A vehicle's details show each recall with
what's wrong, the risk and the fix, and you mark each one **Done** or
**Doesn't apply**. NHTSA's "don't drive it" and "park it outside" warnings are
shown first. The recalls section folds to one line with a count ("1 open · 1
acknowledged") — it opens by itself only while an open recall says don't drive
it or park outside; tap it to open or fold it. For each recall: **Acknowledge**
(you've seen it, not fixed yet — it stops shouting, but I still count it as
unrepaired), **Confirm repaired**, **Doesn't apply**, or **Reopen**. With
Initiative on, I tell you when a new one appears.

If you link the car itself through **Smartcar**, its odometer keeps the
mileage here current — see [smartcar.md](smartcar.md).

I see your vehicles, what's coming due and the latest work on each whenever
we talk, so you can just ask "when is the BMW's registration due?" or "what
should I get done on the car next?". **Ask Athena about it** in a vehicle's
details starts that conversation for you.

## Where to find it

Open **Property** in the left menu and choose the **Vehicles** tab. Use **Add
vehicle**, fill in what you know, and **Save vehicle**. Tap a vehicle's card to
see its details, add to its service history, **Edit** it, or **Remove vehicle**.
Vehicles need a property: if you haven't added one, add it from the
**Overview** tab first.

## When it doesn't work

- If vehicles fail to load, I say so with **Retry**. A failed save keeps the
  form open with what you typed and tells you what to fix.
- "That VIN doesn't look right" — a VIN is letters and numbers without I, O or
  Q. It's optional; leave it blank if you don't have it handy.
- A photo must be an image under 20 MB; I resize it before saving.

## Limits

I can't change your vehicles from a conversation — add and edit them on the
Vehicles tab. Unless the car is linked through Smartcar, mileage is
whatever you last entered or logged. **Recalls are for the model year, not
this car:** NHTSA's list says a recall exists, not whether yours was already
repaired — a dealer can tell you that from the VIN, and you mark it done. I
only send the VIN (to identify the car) and the year, make and model to
NHTSA. Logging a
service doesn't move the next-service date or mileage for you — update those
with **Edit**. I don't send push reminders when something comes due; the Home
banner, the tab and our conversations are where it shows. I don't renew
registration, book service or buy insurance — I can help you find out how.
There's no vehicle card on the main dashboard; only the deadline banner, and
only while a date is close. Up to 20 vehicles per person.

## Under the hood

- Recalls: `src/services/vehicleRecalls.js` (athena_vehicle_recall, migration
  0090) — vPIC VIN decode, then `api.nhtsa.gov/recalls/recallsByVehicle`;
  refreshed on create/VIN change and by the nightly `vehicleRecalls` step;
  `PATCH /api/v1/projects/property/vehicles/:uuid/recalls/:campaign`;
  trigger `vehicle_recall` in `src/services/initiative/triggers.js`.

- UI: `../../../companion/src/components/PropertyVehicles.tsx` (list, add/edit drawer, details drawer with service log), `../../../companion/src/components/propertyVehicles.css`; tab entry in `../../../companion/src/components/Property.tsx` (`property-vehicles`), rendered in `HomePage` in `../../../companion/src/components/Dashboard.tsx`. Due-date tones: `dueItems()` in `../../../companion/src/api/propertyVehicles.ts`.
- Mock: `../../../companion/mock/projects.ts`.
- API: `src/controllers/propertyVehicles.js`, `src/routes/projects.js` — GET/POST `/api/v1/projects/property/vehicles`, PATCH/DELETE `/:uuid`, GET `/:uuid/photo`, POST `/:uuid/service`, DELETE `/:uuid/service/:serviceUuid`. Adult-only, profile-scoped, every write returns the whole list. A new vehicle goes to the person's first property unless a `propertyUuid` they own is named. Tests: `src/controllers/propertyVehicles.test.js`.
- Schema: `db/migrations/0078_property_vehicles.up.sql` — `athena_property_vehicle` (with `property_uuid`, photo column never selected when listing) and `athena_property_vehicle_service` (cascade delete).
- In her prompt: `src/services/projects/prompt.js` reads them through `promptVehicles()`; read-only, never throws, at most six vehicles with their latest two service entries.
- Registration (migration 0095): `registration_state`, `registration_number`, `inspection_station` on `athena_property_vehicle`; recall status gains `acknowledged` (unrepaired, kept in her prompt). Home banner: `VehicleDeadlineBanner` + `deadlines()` (14 days, red at 7) in the companion, rendered under `EmergencyBanner` in `Dashboard.tsx`; no server alert, no push. Mock: `localStorage.mock_vehicle_deadline=true`.
- Not built: due-date push reminders. Athena speaking first is the protected initiative service (`src/services/initiative/`), and a new trigger is the owner's decision.
