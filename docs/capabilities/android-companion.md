---
id: android-companion
title: Android app
summary: My Android app has the same screens as Companion, signs in with Google, and adds what only a phone can do — notifications, hands-free, live heart rate.
where: Athena Android app → Continue with Google → Home
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [android, android app, phone app, apk, google sign-in, phone pairing, on my phone, the app]
---

## What I can do

The app has the same Home, calendar, health, family, work, projects, news, chat,
memories, photos, connected apps and approval screens as Companion, in its
mobile layout, and I'm there as the avatar. Google sign-in picks your account on
the phone. Once the server has checked who you are and that you have access, I
register the phone myself, so you don't have to copy a pairing code. Signing out
removes that registration and clears what the phone stored, even when the
server can't be reached.

The phone also does things the website can't:

- **Notifications.** Nudges, reminders and emergency alerts arrive as phone
  notifications, each with **Acknowledge** and **Remind me in 15**.
- **Hands-free.** Say my name with the screen off and just talk (see
  `hands-free.md`).
- **Live heart rate** from your WHOOP or a heart-rate strap, with limits spoken
  out loud (see `heart-rate.md`).
- **Location**, if you share it: "Where am I?", travel distances from where you
  are, and place reminders when you arrive somewhere (see `location-context.md`
  and `place-reminders.md`).
- **Nearby 911 calls** read from PulsePoint's notifications (see
  `nearby-incidents.md`).
- **Conversation mode**, turn by turn: I listen whenever I'm not speaking.

## Where to find it

Open the Android app and choose Continue with Google. Home opens after sign-in.
More contains the same settings and panels as the mobile Companion website.
Voice input opens Android's speech dialog. Camera and photo buttons ask Android
for permission or open the system file picker when needed. Connected apps opens
provider consent in your browser; return to Athena to see the updated connection.

## When it doesn't work

If Google sign-in is unavailable, check your connection and Google Play services.
The app owner must configure the Android package and signing certificate in
Google Cloud. A removed phone is not silently linked again: sign out and sign in
to link it deliberately. If phone registration fails, the dashboard remains
available and shows a retry message. Update Android System WebView if prompted.

## Limits

- You get the app from **Phone & car** (see `devices.md`): a QR code or a
  Download button, and the same panel in the app tells you when a newer version
  is out. It's Android only; there's no iPhone app.
- The screens are built into the app. A change to the website reaches your
  phone only once the owner publishes a new build of the app.
- Signing in with Google still needs existing Athena access. Data, chat,
  sign-in, my voice and connected apps all need the online server; nothing
  works offline.
- Registering a phone doesn't turn on notifications or my speaking first. You
  choose those yourself, and Android asks for permission.
- No Android Auto messaging. A local Athena server opens in the system browser,
  because the app always talks to the cloud Companion.
- If I can't reach the server when you sign out, an inactive phone entry may
  stay in Phone & car until you remove it there.

## Under the hood

- Shared UI: `../../../companion/src/App.tsx` and `../../../companion/src/native/`.
- Android plugin and scene source: `../../../native-runtime/AndroidCompanion~/`.
  Push (FCM data-only, device-token-authenticated registration) is
  `AthenaDashboard.androidlib/java/com/orcwood/athena/dashboard/AthenaPushService.java`
  and `PushRegistrar.java`. Hands-free, heart rate, geofences and the PulsePoint
  listener sit beside them.
- The UI is bundled into the APK (`DashboardActivity.shouldInterceptRequest`),
  so a Companion deploy needs an APK rebuild to reach the phone. Releases are
  published by `../../../native-runtime/Tools/publish-android.mjs`.
- Installer: `../../../native-runtime/Tools/Install-AndroidCompanion.ps1`.
- Registration tests: `../../../companion/scripts/androidRegistration.test.mjs`.
- Uses existing Google session, access, profile, pairing-code, redemption and
  revocation endpoints. No new authentication bypass or grant is introduced.
- Device token storage uses Android Keystore AES-GCM and no-backup storage;
  status calls return UUIDs only. Web messages require the exact trusted origin
  and main frame. External pages get no native bridge.
