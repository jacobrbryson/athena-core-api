---
id: vehicles
title: Vehicles
summary: I keep track of the vehicles at your property — mileage, registration, inspection, insurance and service due dates, and a service history.
where: the left menu → Property → the Vehicles tab → Add vehicle
status: live
surfaces: [companion]
audiences: [adult]
triggers: [vehicle, vehicles, my car, our cars, truck, van, oil change, registration, inspection, odometer, mileage, tire rotation, service history, car maintenance, vin, license plate, car insurance]
---

## What I can do

Vehicles live under your property, on the Property page's **Vehicles** tab.
For each one you can save what you call it ("The BMW"), its year, make,
model, color, plate and VIN, its odometer reading, and a photo. I show each
vehicle as a card with its mileage and the most pressing thing coming due.

You can add the dates that come due: when registration renews, when
inspection is due, when insurance renews, and the next service by date or by
mileage. In a vehicle's details, **Coming due** lists them soonest first:
red when overdue, yellow within 30 days (or 500 miles of the next service),
green when further out.

**Service history** is a dated log of work done — an oil change, new tires, a
repair — with the mileage and the shop if you like. Logging service with a
mileage higher than the odometer on file updates the odometer too.

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
Vehicles tab. I don't connect to your car or its maker's app, so mileage is
whatever you last entered or logged; I don't read it from the car. Logging a
service doesn't move the next-service date or mileage for you — update those
with **Edit**. I don't send reminders when something comes due; I show it on
the tab and know it when you ask. I don't renew registration, book service or
buy insurance — I can help you find out how. Vehicles stay off the main
dashboard; they belong to the Property page. Up to 20 vehicles per person.

## Under the hood

- UI: `../../../companion/src/components/PropertyVehicles.tsx` (list, add/edit drawer, details drawer with service log), `../../../companion/src/components/propertyVehicles.css`; tab entry in `../../../companion/src/components/Property.tsx` (`property-vehicles`), rendered in `HomePage` in `../../../companion/src/components/Dashboard.tsx`. Due-date tones: `dueItems()` in `../../../companion/src/api/propertyVehicles.ts`.
- Mock: `../../../companion/mock/projects.ts`.
- API: `src/controllers/propertyVehicles.js`, `src/routes/projects.js` — GET/POST `/api/v1/projects/property/vehicles`, PATCH/DELETE `/:uuid`, GET `/:uuid/photo`, POST `/:uuid/service`, DELETE `/:uuid/service/:serviceUuid`. Adult-only, profile-scoped, every write returns the whole list. A new vehicle goes to the person's first property unless a `propertyUuid` they own is named. Tests: `src/controllers/propertyVehicles.test.js`.
- Schema: `db/migrations/0078_property_vehicles.up.sql` — `athena_property_vehicle` (with `property_uuid`, photo column never selected when listing) and `athena_property_vehicle_service` (cascade delete).
- In her prompt: `src/services/projects/prompt.js` reads them through `promptVehicles()`; read-only, never throws, at most six vehicles with their latest two service entries.
- Not built: due-date reminders. Athena speaking first is the protected initiative service (`src/services/initiative/`), and a new trigger is the owner's decision.
