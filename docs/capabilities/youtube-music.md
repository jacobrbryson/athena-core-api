---
id: youtube-music
title: YouTube Music controls
summary: On your Android phone I can skip, go back, pause, play and turn YouTube Music up or down, and tell you what song is playing.
where: the ⋯ menu (top right) → Actions → "Control the music on your phone" (tick "Do this without asking me each time" for instant)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [youtube music, music, song, skip, skip this, next song, previous song, go back a song, pause the music, play the music, resume, louder, quieter, turn it up, turn it down, volume, what song is this, what's playing, who sings this, playlist]
---

## What I can do

On your Android phone I can press YouTube Music's own buttons for you:
**play, pause, next song, previous song, and volume up or down**. Ask in chat
("skip this", "pause the music") and I'll do it once you approve it, or right
away if you've given me a standing "yes" for it.

**Instantly, hands-free.** With hands-free on, say "Athena, skip" (or "pause",
"back", "louder", "quieter", "resume") and, as long as you've ticked **"Do this
without asking me each time"** for music, the phone presses the button the
moment it hears you — no waiting on the internet, so it works on a run or in
the car in a fraction of a second. After my chime the music pauses for the
second or two I'm listening, so I hear you and not the song, then picks up
again (on the next song, for a skip). You'll hear a short tone and the song
changes; volume shows the phone's own slider. Then for a few seconds you can
say "skip" again without my name. I record every press, the same as anything
else I do, even one made with no signal — it's sent once you're back online.

**What song is this?** Ask "what's this song?" or "who sings this?" and I'll
tell you the title and artist from YouTube Music. I don't keep a list of what
you listen to.

## Where to find it

- The ⋯ menu (top right) → **Actions** → **Control the music on your phone**.
  Tick **"Do this without asking me each time"** to make the hands-free
  commands instant. Without it, I still do them — I just ask first.
- Hands-free itself: the ⋯ menu → **Phone & car** → **Hands-free**.
- I need notification access to see YouTube Music: Android Settings →
  Notifications → Device & app notifications → **Athena — read my texts** (or
  **Athena — PulsePoint alerts**). Either one is enough.

## When it doesn't work

- **"Skip" goes to a normal answer instead of happening at once.** Either the
  standing "yes" for music isn't ticked (Actions panel), or the phone hasn't
  checked it since you ticked it — turning hands-free off and on again makes
  it check.
- **Nothing happens.** YouTube Music has to be open and playing (or paused) on
  the phone, and Athena needs one of her notification access switches on.
- **With "only my voice" on.** One word like "skip" is too short for the
  voice filter to tell whose voice it is. When it can't tell and the words are
  exactly a music command, I do it anyway; a voice it judges isn't yours is
  still ignored.
- **I said the wrong thing back.** Only exact short phrases are instant
  ("skip", "next song", "pause the music", "turn it up"). Anything longer goes
  to me as a normal request.
- **In the car with conversation mode on, the music stops.** Conversation mode
  talks over the car's hands-free link like a phone call, and the car pauses
  music for the call. Use hands-free (say my name) in the car instead: the
  music keeps playing and "skip" still works.

## Limits

- I can't play a particular song, artist, album or playlist yet, and I can't
  search YouTube Music. "Play some Tool" doesn't work yet.
- I can't like or save a song yet, and I don't keep songs you like for
  running or driving yet.
- Only YouTube Music, and only on your Android phone — not Spotify, not
  podcasts, not the website or a computer.
- Instant commands need hands-free running and the standing "yes"; without
  them, a music button is a normal request with an approval card.
- In the car, conversation mode pauses the music for as long as it's on.

## Under the hood

- Design and test findings: `docs/architecture/youtube-music.md` (phase 1;
  phases 2–4 — saved songs by situation, Athena playlists via
  `watch?list=` links, skip learning — not built).
- Action: `media_control` in `src/services/actions/registry.js` (`standing:
  true`, `deviceInstant: true`, params `control` ∈ `MEDIA_CONTROLS`),
  executed by `src/services/push/index.js` `sendMediaControl` (silent FCM
  `kind: media_control`). Offered only with a reachable Android phone
  (`hasReachablePhone`).
- Instant path (owner, 2026-11-21, option A): `src/services/actions/index.js`
  `DEVICE_INSTANT` + `reportDeviceExecution`, route `POST
  /api/v1/actions/device/:actionId` (device tokens only,
  `src/controllers/actions.js` `reportDevice`). Records `approval:
  'standing'` with the authority id, or `'unapproved'` + audit
  `action_device_unapproved` when no live authority covered it. Tests in
  `src/services/actions/actions.test.js`.
- Phone: `native-runtime/AndroidCompanion~/AthenaDashboard.androidlib/java/com/orcwood/athena/dashboard/MediaControl.java`
  (phrases, the six buttons, cached authority from `GET /api/v1/actions`,
  reports with an offline queue); `HandsFreeService.onPhone()`;
  `AthenaPushService` (`media_control` push). Hands-free turn outcomes
  `instant` / `nowPlaying` in `src/controllers/handsFree.js`.
- Phase 0 test screen still in the APK: `MediaTestActivity` (long-press the
  icon → Media test); remove once Android Auto is tested.
