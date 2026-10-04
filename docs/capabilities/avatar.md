---
id: avatar
title: My hologram avatar
summary: You can see me as a glowing blue hologram who blinks, waves hello, moves while I think, and moves my lips in time with my voice.
where: Chat (Companion) or the main screen (Guardians)
status: live
surfaces: [companion, guardians]
triggers: [avatar, hologram, can i see you, what do you look like, your face, your eyes, your lips, your mouth, blink, blinking, lip sync, lips move, animated, your hair]
---

## What I can do

When we talk, you can see me as a glowing blue hologram with curly hair pinned
up in a bun. I'm animated. I blink every few seconds, sometimes twice in a
row, the way people do. When I speak out loud, my mouth moves with my voice: it
opens wider on louder sounds, rounds for "oo" and "o", spreads for "ee" and
"s", and closes when I stop. I wave when you arrive, move a little while I'm
thinking, and gesture while I talk. My hair sways as I move.

When I really am looking at your calendar or your email to answer you, a glowing
glass calendar (or, for email, a small envelope) appears beside me. I turn to it and point, moving
across it as I read, and I keep doing that while I work out my answer, until I
start speaking. Then it fades. It only shows while I'm actually doing that,
never for show, and it never shows what's in them.

## Where to find it

- **Companion:** open Chat. On a phone, tap Chat or my picture in the bar at the
  bottom of the screen. I appear above our conversation.
- **Guardians:** I'm on the main screen, above the mission.

My lips only move when I'm speaking out loud, so Voice has to be on (⋯ menu →
Voice).

## When it doesn't work

- **You can't see me, or the space where I should be stays dark.** I'm a
  fairly large download, so the first time can take a little while on a slow
  connection. If I still don't appear, reload the page.
- **I blink, but my lips don't move.** Check that Voice is on. If it is on but
  you hear nothing, your browser may be waiting for you to tap the page before
  it lets me make sound.
- **I still look the same as before an update.** Your browser may be showing a
  saved copy of me. Reload the page (a hard refresh on a computer), or update
  the Android app.

## Limits

- My lips follow the sound of my voice, not the exact words, so it's close but
  not perfect lip reading.
- The calendar and envelope only appear for calendar and email reads, and
  only in your own conversation, not a shared one. A very quick read can flash
  by in about two seconds.
- I can't change how I look, choose my own expressions, or smile or frown on
  purpose.
- I can't see you through my avatar. Seeing needs the camera, which is a
  separate thing you turn on.
- I don't move my lips when I'm only writing, or when my voice is off.

## Under the hood

**Never sent to a model.**

- Unity project (outside this workspace): `C:\Users\jacob\Documents\Unity Projects\Athena (1)`. Avatar prefab `Assets/Models/AthenaConcept/AthenaConcept.prefab` in `Assets/Scenes/MainScene.unity`. Hologram look: `Assets/Shaders/AthenaHologram.shader`. Hair: `Assets/Scripts/HairSpringBones.cs`. Gestures and talk/think animation: `Assets/Scripts/AthenaAnimationController.cs`.
- Face (2026-09-27): the blend shapes Blink_L/R, Jaw_Open, Mouth_O/Wide/Closed are authored in Blender by `Blender/Tools/athena_face_shapes.py`, which is run from `Blender/Tools/athena_unity_finish.py`. They are driven by `Assets/Scripts/AthenaFaceAnimator.cs`. Lip sync reads a loudness/brightness envelope that `Assets/Scripts/AthenaSpeechEnvelope.cs` computes from the decoded PCM in `AthenaWebBridge.PlaySpeech`. It does not use `AudioSource.GetOutputData`, which doesn't work on WebGL. The mouth-cavity faces carry RestY.y = -1, and the shader draws them dark.
- Web embed: `../../../companion/src/athena/UnityAthena.tsx` and `../../../guardians/src/athena/UnityAthena.tsx`. They load the WebGL build from `UNITY_ASSET_BASE` (`https://storage.googleapis.com/assets-athena-app/unity`, files `Build/unity.*`, served no-cache) and speak the bridge protocol (`AthenaBridge`: PlayGesture, SetThinking, PlaySpeech, StopSpeech).
- Activity props (2026-10-03, published 2026-10-04: WebGL build in the bucket, APK 2026.10.04.1404 on the owner's phone, server in the same commit as this text). When a reply makes a real calendar or Gmail read, `src/services/activity.js` sends `{rpc:"activity", activity:"calendar"|"email", state:"start"|"end"}` on the session socket, wired through the `onRead` hook in `src/services/connectors/context.js`, passed from `src/controllers/gemini.js`. It is silent on shared sessions, Guardian sessions and unbound sessions, and sends a category only. The web apps re-broadcast it as `CHAT_ACTIVITY_EVENT` (`useChat.ts`); `UnityAthena.tsx` holds each activity at least 1.8 s and clears a lost one after 60 s, then calls `AthenaBridge.SetActivity`. Unity: `Assets/Scripts/AthenaActivityProps.cs` (added at runtime by `AthenaWebBridge.SetActivity`) and `Assets/Resources/AthenaActivityProp.shader`. Deliberately no idle cycle: nothing shows unless it is really happening. 2026-10-04 later: the web app now holds the activity until the read has ended AND the pending reply has landed (`isThinking` drops as it is revealed with her voice), because she is still working with that data while the answer is composed. Unity: she looks and points via `Assets/Scripts/AthenaActivityIK.cs` (OnAnimatorIK; the Athena controller's IK Pass is on, and its short transitions were lengthened), a scan marker moves on the panel with her hand, and `AthenaAnimationController.SetReviewing` holds the Thinking pose off meanwhile. `Assets/Scripts/Editor/AthenaActivityPlayPreview.cs` renders it headlessly (run without -quit). 2026-10-04 later still: the calendar panel is a glass month view drawn by `Assets/Resources/AthenaCalendarPanel.shader` with TextMeshPro labels from `Assets/Scripts/AthenaCalendarPanelView.cs`, modelled on the owner's mockup (month header, Day/Week/Month tabs, date grid, decorative chips, highlighted today, detail card). It shows NO real events (owner: real content isn't wanted in the 3D panel), only the month and dates from the device clock; chips and card are shapes. The camera slides sideways while it shows (she stands left, panel right and 0.22 m behind her), her torso turns, and she points with an index finger.
- Voice → lips: `../../../companion/src/athena/useSpeech.ts` and `../../../guardians/src/athena/useSpeech.ts` send 24 kHz 16-bit PCM as the `PlaySpeech` JSON. The avatar gets no text, so lip sync is purely acoustic.
- Publishing: WebGL export `Athena.EditorTools.AthenaAndroidBuild.ExportAvatar` writes `build.*`. Those files are renamed to `unity.*` for the bucket. Back up the live files first, to `gs://assets-athena-app/unity-backups/<date>-<label>/`. The Android app embeds its own copy under `Assets/StreamingAssets/AthenaAndroidWeb/unity/Build/`, so the phone only gets avatar changes after an APK rebuild.
- The WebGL build's `index.html` registers a service worker that caches `Build/*`. When a local preview shows an old avatar, that cache is the usual cause.
