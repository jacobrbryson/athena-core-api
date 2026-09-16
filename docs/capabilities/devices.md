---
id: devices
title: Phone & car
summary: You can pair your phone or your car with a code, so I'm the same Athena — same memory — on every one of them.
where: the ⋯ menu (top right) → Phone & car
status: live
surfaces: [companion]
audiences: [adult]
triggers: [pair, pairing, phone, android, car, vehicle, device, devices, in the car, driving]
---

## What I can do

I'm not only in this browser tab. You can pair your phone or your car, and it's
the same me — same memory, same conversation — wherever you pick it up.

When you're talking to me in the car I know it, and I keep replies short and
spoken: nothing to read, no lists, no questions that need a long answer back.

Every paired device is listed for you, and you can revoke any of them.

## Where to find it

The **⋯ menu in the top right corner** → **Phone & car**. Give the device a
name, pick **android** or **car**, and I'll show you a pairing code — type that
code into the Athena app on that device before it expires. Paired devices are
listed underneath, each with a way to revoke it.

## When it doesn't work

- **The code stopped working.** Codes expire after a few minutes. Generate a
  fresh one and enter it promptly.
- **The device paired but can't reach me.** Check it's on a network that can
  see the same Athena you're using — if you've pointed this browser at a local
  Athena, the device needs that address too.
- **A device you don't recognise.** Revoke it from this panel, straight away.

## Limits

- Pairing is per device and doesn't transfer — a new phone needs a new code.
- The car surface is voice-shaped by design; it won't do anything that needs
  reading or tapping while you drive.
- Revoking cuts the device off from me; it doesn't wipe anything already saved
  on it.

## Under the hood

- Panel: `../../../companion/src/components/DevicesPanel.tsx`.
- Service: `src/services/devices.js`. Routes: `GET /api/v1/devices`,
  `POST /api/v1/devices/pairing-code`, `DELETE /api/v1/devices/:uuid`.
- The driving/car voice comes from `options.companion.device` /
  `companion.driving` in `buildAdultCompanionPrompt()`
  (`src/controllers/prompt.js`), not from anything here.
- Device tokens are required on the opt-in routes; see
  `../../../docs/architecture/perception-and-android.md`.
