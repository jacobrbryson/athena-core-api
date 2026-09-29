---
id: devices
title: Phone & car
summary: You can pair your phone or your car with a code, so I'm the same Athena — same memory — on every one of them.
where: the ⋯ menu (top right) → Phone & car
status: live
surfaces: [companion]
audiences: [adult]
triggers: [pair, pairing, phone, android, car, vehicle, device, devices, in the car, driving, install, download, apk, tablet, old phone, update the app]
---

## What I can do

I'm not only in this browser tab. You can pair your phone or your car, and it's
the same me — same memory, same conversation — wherever you pick it up.

When you're talking to me in the car I know it, and I keep replies short and
spoken: nothing to read, no lists, no questions that need a long answer back.

Every paired device is listed for you, and you can revoke any of them.

**You can put the Android app on another phone or tablet from here too** — an
old phone you run with, a tablet in the office. The panel shows a QR code; scan
it with that device's camera and it downloads the app straight away, without
signing in on it first. Then open Athena on the new device and sign in or pair
it. Inside the Android app, the same panel tells you when a newer version is out
and fetches it for you.

## Where to find it

The **⋯ menu in the top right corner** → **Phone & car**. Give the device a
name, pick **android** or **car**, and I'll show you a pairing code — type that
code into the Athena app on that device before it expires. Paired devices are
listed underneath, each with a way to revoke it.

## When it doesn't work

- **"No Android build has been published yet."** Nothing's been released for
  download; the owner publishes builds. Nothing is wrong with your account.
- **The QR code stopped working.** Download links last fifteen minutes. Close
  and reopen the panel for a fresh one.
- **Android won't install it.** Allow installs from the browser when Android
  asks (Settings → Apps → your browser → Install unknown apps). It needs
  Android 9 or newer. If it says the app conflicts with an existing one, that
  phone has an older build signed differently — uninstall it once, then install.

- **The code stopped working.** Codes expire after a few minutes. Generate a
  fresh one and enter it promptly.
- **The device paired but can't reach me.** Check it's on a network that can
  see the same Athena you're using — if you've pointed this browser at a local
  Athena, the device needs that address too.
- **A device you don't recognise.** Revoke it from this panel, straight away.

If you've turned on notifications, a paired phone is also how I reach you when
you don't have me open — see **Initiative** for what I'd send and how often.
You allow that on the phone itself, and you can switch it off from either end.

## Limits

- Pairing is per device and doesn't transfer — a new phone needs a new code.
- Notifications only work on a paired phone or car, never the browser, and only
  if the server has been set up for them.
- The car surface is voice-shaped by design; it won't do anything that needs
  reading or tapping while you drive.
- The download link works for whoever has it for fifteen minutes — that's
  what lets the QR code work on a phone that isn't signed in. Installing grants
  nothing; the device still has to sign in or pair.
- Android only. There's no iPhone app.
- Revoking cuts the device off from me; it doesn't wipe anything already saved
  on it.

## Under the hood

- Panel: `../../../companion/src/components/DevicesPanel.tsx`.
- Service: `src/services/devices.js`. Routes: `GET /api/v1/devices`,
  `POST /api/v1/devices/pairing-code`, `DELETE /api/v1/devices/:uuid`.
- The driving/car voice comes from `options.companion.device` /
  `companion.driving` in `buildAdultCompanionPrompt()`
  (`src/controllers/prompt.js`), not from anything here.
- Install / update: `../../../companion/src/components/AndroidInstall.tsx`,
  `src/services/androidRelease.js`. `GET /api/v1/android/release` (the published
  version) and `POST /api/v1/android/release/link` (a 15-minute V4 signed URL
  into the private `athena-android-releases` bucket — the ~130 MB APK is too big
  for Cloud Run to serve). Published with
  `../../../native-runtime/Tools/publish-android.mjs`, which refuses debug-signed
  builds, a changed signing key, and a version that doesn't go up.
- Device tokens are required on the opt-in routes; see
  `../../../docs/architecture/perception-and-android.md`.
