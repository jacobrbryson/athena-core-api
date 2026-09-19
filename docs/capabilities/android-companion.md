---
id: android-companion
title: Android Companion dashboard
summary: I have an Android dashboard build that shares Companion's screens and links the phone after Google sign-in.
where: Athena Android app → Continue with Google → Home
status: planned
surfaces: [companion]
audiences: [adult]
triggers: [android, phone app, apk, google sign-in, unity scene, phone pairing]
---

## What I can do

I use the same Home, calendar, health, family, work, projects, news, chat,
memories, photos, connected apps, and approval screens as Companion. I keep the
mobile layout, landscape artwork, icons, and navigation shared with the web app.
I keep the dashboard above Android's navigation controls and on-screen keyboard.
Google sign-in selects your account on the phone. After the server verifies your
identity and access, I register this phone without asking you to copy a pairing
code. Sign-out attempts to remove that registration and clears the phone's
stored identity and session even if the server is unreachable.

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

This is an implementation awaiting an installed-device acceptance test and a
signed release; it is not yet a published Android download. Google sign-in still
requires existing Athena access. The dashboard and avatar assets are packaged,
but data, chat, sign-in, voice generation, and provider connections need the
online backend. This scene does not run the legacy native offline model,
Android Auto messaging, or background push-registration services. A phone
registration alone does not enable notifications or initiative. Local-server
handoff opens the system browser; this Android shell is pinned to cloud Companion.
If I cannot reach the server during sign-out, an inactive phone entry may remain
in Phone & car until you remove it there.

## Under the hood

- Shared UI: `../../../companion/src/App.tsx` and `../../../companion/src/native/`.
- Android plugin and scene source: `../../../native-runtime/AndroidCompanion~/`.
- Installer: `../../../native-runtime/Tools/Install-AndroidCompanion.ps1`.
- Registration tests: `../../../companion/scripts/androidRegistration.test.mjs`.
- Uses existing Google session, access, profile, pairing-code, redemption and
  revocation endpoints. No new authentication bypass or grant is introduced.
- Device token storage uses Android Keystore AES-GCM and no-backup storage;
  status calls return UUIDs only. Web messages require the exact trusted origin
  and main frame. External pages get no native bridge.
