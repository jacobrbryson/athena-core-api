---
id: conversation-mode
title: Conversation mode
summary: In the chat you can leave the mic on and just talk with me; in desktop Chrome or Edge you can also cut in while I'm talking.
where: Chat → … input menu → Conversation mode (any browser with speech recognition, and the Android app)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [conversation mode, leave the mic on, keep the mic on, mic on, just talk, talk naturally, interrupt you, talk over you, cut you off, stop talking, barge in, hands free on my computer, always listening]
---

## What I can do

Turn on conversation mode and the microphone stays on: you just talk, and I
answer out loud when you've finished. You don't press anything between turns.
I wait a little longer if you trail off on "and…" or "um", so pausing to think
doesn't cut you off.

You can talk over me. When you start talking while I'm speaking, I stop, so you
can say "wait" or ask something else. A quick "mm-hm" doesn't stop me; it takes
a moment of real speech, and a little longer while I'm singing. When you cut me
off I know how far I'd got, so I won't pretend you heard the rest.

While it's on, a small **Conversation on** indicator stays below the message
box, with a dot that lights up brighter whenever it hears you. Tap the indicator
to stop. What you're saying shows in the chat as you say it. It turns itself off
when you switch to another tab or after two quiet minutes.

## Where to find it

Open Chat in desktop Chrome or Edge 135 or newer. Open **Input**, to the left
of **Tell Athena…** (the **…** button), then choose **Conversation mode** to turn it on or off.
The input menu button is circular, with three centered dots.
Each option has an icon: infinity for Conversation mode, a microphone for
Click to talk, an eye for Let her see, and a picture for Show a photo.
The first time, the browser asks to use your microphone. Hover over Input
for a tooltip describing the voice, camera and photo options.

In the Android app, phone and tablet browsers, Safari, and older Chrome it's
the same menu item, without cutting in. The first time, Android or the browser
asks to use the microphone. There I listen whenever I'm not talking: I stop listening
the moment I start answering and start again once I've finished, so you can't
cut in — wait for me to finish. The phone may play its own short tone each
time it starts listening.

For a single turn, choose **Input → Click to talk**. It turns conversation
mode off, stops my current spoken reply as it starts listening, and closes
after your utterance before I answer. A small **Listening** indicator lets
you stop it early.

## When it doesn't work

- **It doesn't notice me talking.** It learns how loud the room is when you
  turn it on, so turn it on while things are quiet. A noisy room or music can
  hide your voice.
- **I stop talking when you didn't say anything.** On a laptop's speakers my
  own voice can reach the microphone. I use the browser's echo cancellation
  and keep listening for your interruptions, but loud speakers or a reflective
  room can still cause mistakes. Lower the speaker volume or try headphones.
- **I can't cut in.** Only desktop Chrome or Edge 135 or newer can send
  echo-controlled audio to speech recognition, which interrupting needs.
  Elsewhere conversation mode works turn by turn: wait for me to finish.
- **Safari stops listening after the first turn.** Safari can be strict about
  starting speech recognition without a tap. Turn conversation mode off and on,
  or use Chrome.
- **"Couldn't reach speech recognition."** The browser's speech recognizer
  needs an internet connection. Typing still works.
- **"Hands-free is listening already."** (Android) Hands-free and conversation
  mode both need the microphone. Turn hands-free off in Phone & car first.
- **On the phone I didn't answer something you said while I was talking.** The
  phone stops listening while I speak, so it never heard it. Say it again
  after I finish.

## Limits

- Talking over me: desktop Chrome or Edge 135 or newer only. Turn by turn:
  the Android app (this version or newer; older installs show the option
  greyed out) and any other browser with speech recognition. On the phone
  with Athena closed, hands-free is the way to
  talk to me without touching anything. Firefox has no speech recognizer,
  so the voice options are disabled there. Other browsers with speech recognition
  may show the option but cannot start this mode with echo control.
- Turning your voice into words is done by the browser. In Chrome that means
  Google's servers. Recognition starts when it detects a voice and can stay
  open for a few seconds afterward. It receives the echo-cancelled microphone
  stream; while I'm speaking, sound judged to be only my echo is silenced on
  that stream. This detector can make mistakes, so background sound can still
  reach recognition. The sound itself never comes to me, only the words.
- Turn-by-turn in a browser, the browser's recognizer hears the plain
  microphone, only while I'm quiet.
- In the Android app the phone's own recognizer does it — on the phone itself
  when it has the language pack, otherwise Android's speech service (Google's,
  the same one Click to talk uses). No barge-in there, and it stops when you
  leave the app.
- If you start talking again while I'm still working out an answer, both of
  your messages go through, and you may hear my answer to the first after
  you've moved on.
- It doesn't know who is talking, so anyone near the microphone is talking to
  me as you.

## Under the hood

**Never sent to a model.**

- Hook: `../../../companion/src/athena/useConversation.ts`. An energy detector
  runs on an echo-cancelled `getUserMedia` stream through an AnalyserNode,
  every 30 ms. It learns the room in the first ~300 ms, then counts a frame
  more than 10 dB over the floor as voice, needing three frames in a row. A
  voice opens the browser's `SpeechRecognition` (continuous, interim results),
  which closes 2.5 s after the voice stops. Auto-off after 120 s of quiet, and
  on `visibilitychange` to hidden.
- Audio graph: `../../../companion/src/athena/conversationAudio.ts` splits the
  same microphone source into an analyser and a gain → MediaStreamDestination
  branch. `SpeechRecognition.start(track)` consumes the generated track rather
  than opening a second microphone. Echo cancellation is requested as an exact
  constraint, noise suppression is requested, and automatic gain control is
  disabled to keep the level comparison stable. The gain silences only the
  recognizer branch when the detector judges the signal to be echo; the analyser
  remains live for barge-in. All input and generated tracks are stopped on exit.
  Desktop Chromium 135+ is required; older engines can ignore the track argument.
- Her echo: `useSpeech.now().loudness(250)` is her playback level from the
  clip's own PCM (`../../../companion/src/athena/voiceLevel.ts`, 20 ms frames).
  `../../../companion/src/athena/echoGate.ts` learns the mic-minus-playback loss
  from frames that were only her (starting at -15 dB, meaning a loud echo) and
  counts a frame as you only when it's 9 dB above her predicted echo, or she's
  quiet. Words are sent only when ≥ 3 frames of you were heard since the last
  turn. One- or two-word finals with recognizer confidence < 0.5 are dropped
  (noise made into "okay").
- End of turn: `../../../companion/src/athena/turnTaking.ts` `turnWaitMs`, counted
  from when the detector stops hearing you (400 ms hangover). It waits 300 ms,
  or 1.6 s after a trailing conjunction, filler or comma, and at least 350 ms
  for unsettled (interim) words. It doesn't wait for the recognizer to
  finalise: results already sent are skipped by index (`consumed`) when they
  finalise later. Any new voice cancels the wait.
- Barge-in: voice for ≥ 300 ms (700 ms while singing) AND recognized words that
  `mightBeHer` (`../../../companion/src/athena/echo.ts`) doesn't take for her
  own sentence. That calls `speech.interrupt()` in `useSpeech.ts`, which stops
  Unity (`StopSpeech`, so lips and the talk pose stop) and drops any warm-up or
  song still queued. It returns `{ heard, singing }`. `heard` is the spoken
  parts already played plus the current part's words scaled by elapsed time.
- Turns: `CompanionConsole.tsx` `talk` sends `companion.conversation: true` and,
  after a barge-in, `companion.cutOff`. `src/controllers/message.js`
  `parseMessageContext` caps `heard` at 600 characters, and applies the
  hands-free echo refusal (409) to conversation turns too.
  `src/controllers/prompt.js` adds the "TALKING with you out loud" rule (adult
  prompt) and the `# You were interrupted` block.
- Echo: `../../../companion/src/athena/conversationEcho.ts` retains up to 16
  recent playback texts for 15 s, including fillers, and holds the last sound
  level for a 600 ms acoustic tail after end or interruption. Interim results,
  finals and commits use the same rejection check. A short matching fragment
  captured during playback is rejected even when delivered after playback ends;
  a new short follow-up after playback is allowed. Long matches use `isEcho`.
  A submitted turn aborts its recognizer, so late results cannot borrow the next
  turn's voice evidence. Voice evidence requires three consecutive frames,
  rather than accumulating isolated loud frames. The server's existing
  `src/services/echo.js` refusal remains an additional guard.
- One-shot input: `../../../companion/src/athena/useVoiceInput.ts` aborts before
  dispatching a final transcript and ignores callbacks from finished/stopped
  recognizers. `CompanionConsole.tsx` interrupts current TTS when the mic is
  deliberately opened. Android's existing native one-shot recognition remains
  separate from conversation mode.
- Tests: `../../../companion/scripts/conversation.test.mjs`,
  `../../../companion/scripts/conversationRuntime.test.mjs` and `echoGate.test.mjs` (`npm run test:speech`),
  `src/controllers/messageFiller.test.js`, `src/controllers/prompt.test.js`.
- Turn by turn: `useConversation.ts` `startTurns(listener)` when
  `supportsRecognitionTrack` is false or in the Android app. Listeners are in
  `../../../companion/src/athena/turnListener.ts`: `browserTurnListener` (one
  non-continuous `SpeechRecognition` per utterance, no track) and
  `androidTurnListener`. Android: the WebView has no `SpeechRecognition`, so it
  calls the bridge `conversationListen` once per turn
  (`native-runtime/AndroidCompanion~/AthenaDashboard.androidlib/.../ConversationListener.java`:
  an in-app `SpeechRecognizer`, on-device on API 31+ when available, else the
  system one; partial words come back as `athena-conversation-partial` events).
  Every 150 ms the page checks `speech.now()`: while she plays it cancels the
  listener (`conversationCancel` / `abort()`); it listens again 600 ms (`ECHO_TAIL_MS`) after she
  stops. Results still pass `ConversationEcho`. Refused while hands-free runs
  (one microphone). Stops on `athena-native-pause` (the activity also cancels
  in `onPause`), hidden, or 120 s of quiet. Needs an APK rebuild to ship.
- Not yet: Guardians, barge-in outside desktop Chromium, knowing
  whether headphones are in, or superseding a reply still being written when
  they talk again.
