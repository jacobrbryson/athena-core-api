---
id: voice-filter
title: Only my voice
summary: On the Android app I can learn your voice so conversation mode and hands-free ignore other people talking nearby.
where: Companion → Phone & car → Only my voice (Android app only)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [only my voice, my voice only, voice filter, voiceprint, recognize my voice, learn my voice, other people talking, my wife, someone else talking, ignore other people, picking up other people, answered someone else, who is talking, speaker recognition]
---

## What I can do

On the Android app I can learn what your voice sounds like. After that, when
conversation mode or hands-free hears something, the phone checks whether it
was you before anything is sent. If it was someone else, like family talking in
the next room or the TV, I drop it: I don't answer it, it isn't sent to me,
and it isn't saved.

Teaching me takes about 15 seconds of you reading a few sentences aloud. You
can check whether I recognize you, switch the filter off and on, or delete your
voiceprint whenever you like.

Your voiceprint is made on the phone, stays on the phone, and is encrypted
there. It is used only to tell your voice from other voices. It never goes to
my servers.

## Where to find it

In the Android app, open **Phone & car** and find **Only my voice** under
Hands-free:

- **Teach Athena your voice**: read the sentences on screen aloud until the bar
  fills.
- **Check it knows me**: say a sentence and the panel says whether it sounded
  like you, with a score.
- **Only answer my voice**: switches the filter on or off without deleting
  anything.
- **Teach again**: replaces your voiceprint with a new one.
- **Delete my voiceprint**: removes it and its key from the phone.

The panel also shows how many turns it ignored because they were someone else.

In the car the car's microphone makes you sound different, so you can teach
your voice a second time there: Phone & car → In the car → **Teach my voice in
the car**, parked, with conversation mode off and the phone connected to the
car. I keep both, and a turn counts as yours if it matches either.

Conversation mode and hands-free must be off while you teach or check, because
they use the microphone.

## When it doesn't work

- **It ignored you.** Check the score with **Check it knows me**. If it's low,
  teach again in a quiet room with the phone about where it usually is when you
  talk to me. A cold, whispering or shouting can lower the score.
- **It still answered someone else.** When two people talk over each other, the
  turn can sound enough like you to pass. Someone who sounds a lot like you can
  also pass.
- **"I didn't hear enough of your voice."** It needs about 15 seconds of
  speech. Read all of the sentences, a little closer to the phone.
- **"That sounded like more than one voice."** Someone else talked while it was
  learning. Teach again with just you talking.
- **The panel isn't there.** It needs the Android app from 2026-11-05 or later,
  on Android 13 or newer.

## Limits

- Android app only, on Android 13 or newer. Not in browsers, on the web, or in
  Guardians.
- One voice per phone: the phone's owner, taught once on the phone and,
  optionally, once more in the car.
- With the screen on, if the phone's own recognizer won't take the app's audio,
  turns on screen go unchecked (the phone logs it). With the screen locked it
  switches to the offline recognizer instead, which is less accurate but still
  checked.
- Very short replies ("yes", "stop") are harder to judge than a sentence.
- Words someone else says partway through your own sentence can come through
  with yours.
- What you're saying still appears in the chat as you talk, before the check.
  A turn that turns out to be someone else's disappears without being sent.
- The voiceprint isn't backed up or copied to a new phone. Teach the new phone
  again.
- The match level is set from a few of your own turns. Tested 2026-11-05: I answered you and ignored the other voice nearby, but that voice was too quiet to score, so a louder voice close to the phone hasn't been tested yet.

## Under the hood

- Owner-chosen 2026-11-05, after the locked phone answered an in-person
  conversation in another room for about 15 minutes. Everything is on the
  phone. The server's voiceprints (`../../src/services/guardianMissions/voiceprints.js`,
  Guardians) are a separate system and aren't used here.
- `../../../native-runtime/AndroidCompanion~/AthenaDashboard.androidlib/java/com/orcwood/athena/dashboard/Voiceprint.java`:
  - Makes the print: a Vosk x-vector (128 numbers) of the voiced audio, built
    with `vosk-model-spk-0.4` and the small English model, decoding free-form.
    A one-word `[unk]` grammar gives no vector, because Vosk skips it for a
    result with no words.
  - Enrollment averages 3 s pieces. It refuses when the lowest piece is under
    0.3 similarity to the average.
  - Storage: AES-GCM with an Android Keystore key, in `noBackupFilesDir/voiceprint.bin`.
  - `check()` keeps a turn at cosine ≥ `MATCH` (0.30). Measured 2026-11-05: the owner scored 0.36–0.62. Two turns from another voice in the room were too quiet for Vosk to decode any words, so they got no vector and were dropped. A louder other voice hasn't been scored. It drops one with under
    300 ms voiced as too quiet. A failed check keeps the turn.
  - It logs each verdict under `AthenaVoiceprint` (score, voiced ms, compute ms),
    never the words.
- `../../../native-runtime/AndroidCompanion~/AthenaDashboard.androidlib/java/com/orcwood/athena/dashboard/MicFeed.java`:
  - The app records the microphone itself and hands it to Android's on-device
    recognizer through `EXTRA_AUDIO_SOURCE` (API 33+), over a pipe. It never
    blocks the mic: a chunk the recognizer can't take is skipped.
  - It keeps only voiced chunks (an energy gate with pre-roll and hang-over)
    for the check. If under 1 s crosses the gate, it judges the whole recording.
  - `Voiceprint.Live` works out the x-vector on its own thread while they talk,
    so only Vosk's last result is left when the turn ends. Computing it
    afterwards added about 1.3 s to each reply.
- Gated paths: `ConversationListener` (screen on) checks off the main thread
  and answers a rejected turn as silence. `HandsFreeService.onDevice`, `vosk()`
  and `afterName` (locked conversation, hands-free) return `""`. If the
  on-device recognizer refuses the feed (`feedRefused`), the service uses Vosk.
- `../../../native-runtime/AndroidCompanion~/AthenaDashboard.androidlib/java/com/orcwood/athena/dashboard/VoiceEnrollment.java`:
  bridge calls `voiceprintListen {mode: enroll|check}`, `voiceprintStatus`,
  `voiceprintCancel`, `voiceprintFilter {on}` and `voiceprintDelete` (in
  `DashboardActivity`). It refuses while conversation mode or hands-free holds
  the mic.
- `VoskModels.java` shares one copy of each model per process.
  `../../../native-runtime/Tools/Install-AndroidCompanion.ps1` fetches the speaker model.
  The model publisher lists no hash, so the SHA-256 was pinned on first download.
- Car print (2026-11-05): `voiceprint-car.bin`, the same Keystore key,
  made by `voiceprintListen {mode: "enroll", car: true}`, which holds
  `CarAudio` while it records so the audio is the car's microphone. `judge`
  scores against both prints and keeps the higher ("your voice in the car"
  when the car's won). Delete removes both.
- UI: `../../../companion/src/components/VoiceFilter.tsx`, `../../../companion/src/components/CarConversation.tsx` and `../../../companion/src/native/voiceprint.ts`.
  It needs an APK rebuild, because the APK bundles the web UI.
