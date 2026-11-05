---
id: conversation-mode
title: Conversation mode
summary: Leave the mic on and just talk; on Android it keeps going with the screen locked or in the car, and in desktop Chrome or Edge you can cut in.
where: Chat → … input menu → Conversation mode (any browser with speech recognition, and the Android app)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [conversation mode, leave the mic on, keep the mic on, mic on, just talk, talk naturally, interrupt you, talk over you, cut you off, stop talking, barge in, hands free on my computer, always listening, screen locked, lock my phone, phone in my pocket, hmm, are you still there, in the car, while driving, car speakers, car microphone, bluetooth, hands-free in the car, talk through the car]
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

While I'm working out an answer I let you know I heard you: "Hmm." a second
and a half after you stop talking (in conversation mode on the phone; from
when your message goes out elsewhere), unless I've already started
answering. When I can tell straight away that I need to look something up, I
say that instead, and I skip the "Hmm.": "Let me check your calendar." (or your
email, WHOOP, heart rate, or where your phone is) when it's one obvious thing,
"Let me look that up." for a web search, "Let me think back." for something
you told me before, and "Just a moment." when it takes several lookups. A
question that needs no lookup just gets the "Hmm." This happens whenever my
voice is on, not only in conversation mode.

While it's on, a small **Conversation on** indicator stays below the message
box, with a dot that lights up brighter whenever it hears you. Tap the indicator
to stop. What you're saying shows in the chat as you say it. In a browser it
turns itself off when you switch to another tab or after two quiet minutes.

In the Android app it keeps going when you lock the screen or switch apps.
The notification shade shows **Athena conversation mode — Conversation on**
for as long as it can listen. With Athena off screen the phone listens for
each turn, sends what you said, and answers in my voice on its own. If you
asked something just before locking, it says my answer when it arrives. When
you come back to Athena the chat takes over again. Stop it from the
notification's **Stop conversation** button or from the chat. It turns itself
off after five quiet minutes with the screen off.

In the car, with your phone connected to it over Bluetooth, conversation mode
talks through the car the way a phone call does: the car's microphone hears
you and I answer on the car's speakers, whatever the car is playing. While
it's on, the phone does all the talking even with Athena on screen, so the
chat shows the conversation but my avatar doesn't speak. I sound like a phone
call, and the car mutes the radio for as long as conversation mode is on.
Turn it off under Phone & car → In the car → **Use the car's hands-free**.

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
- **On the phone it heard you but nothing was sent.** Before 2026-11-04 the
  phone's own recognizer (on newer Android) cut a long sentence into pieces
  and handed over only the last piece, often empty, so your turn was lost.
  The fixed app keeps every piece. Update the Android app if it still happens.
- **It stopped when the screen locked.** Older Android apps turned it off on
  any pause. Update the app. If Android asks, allow notifications too, so the
  "Conversation on" notice shows while it listens.
- **With the screen locked it heard you but you heard nothing back.** Before
  2026-11-04 the phone played my off-screen voice on Android's separate
  Assistant volume, which some Samsung phones keep at 0 for the speaker. It
  now uses the normal media volume. If I'm still quiet, turn the media volume up.
- **The phone's recognizer stopped producing words at all** (it hears you start
  but nothing ever appears). Google's speech service on the phone can get
  stuck. Restarting the phone fixes it.
- **It answered other people talking nearby.** With no wake word it hears
  everyone in the room. In the Android app, teach it your voice in Phone &
  car → Only my voice, and it ignores anyone else.
- **In the car it didn't hear you, or you couldn't hear me.** (Android) Before
  2026-11-05 the phone used its own microphone and played my voice as media
  even in the car, so road noise hid you and my voice only reached the
  speakers when the car was on Bluetooth audio. Update the app. Then check
  Phone & car → In the car says your car is connected. If it asks for Nearby
  devices, allow it: that's how the phone tells a car from earbuds.
- **In the car with Only my voice on, it ignored you.** The car's microphone
  makes you sound different. Teach it your voice in the car too, under Phone &
  car → In the car, parked with conversation mode off.
- **"Hmm." didn't play the first time.** The phone or browser fetches it the
  first time my voice is on, so the very first wait can be quiet.

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
  the same one Click to talk uses). No barge-in there. With the screen off it
  transcribes on the phone only (its on-device recognizer, or the offline
  hands-free model), so no sound leaves the phone, only the words.
- With the screen locked the replies are made for listening, like hands-free:
  short, no lists. My avatar doesn't move while the screen is off. If I was
  partway through a reply when you locked the phone, the rest may be cut off.
- The phone's recognizer may play its own tone each time it starts listening.
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
  stops. Results still pass `ConversationEcho`. Refused while wake-word
  hands-free runs (one microphone). In a browser it stops on hidden or after
  120 s of quiet. In the Android app it does not stop on `athena-native-pause`;
  `athena-native-resume` resets the quiet clock.
- Segmented results (2026-11-04): on a Galaxy S25 (SDK 37), Android System
  Intelligence's on-device recognizer sent a long utterance as segments and
  delivered only the last, often empty, in `onResults`. `HeardSoFar.java` keeps
  every segment from the partial results (a restart that is much shorter with
  a different first word, or an empty partial, closes a segment), and is used
  by both `ConversationListener` and `HandsFreeService.onDevice`. Words already
  heard win over a later error. `ERROR_RECOGNIZER_BUSY` is retried six times
  at 400 ms while the service lets go of the mic.
- Locked screen: starting it calls the bridge `conversationService {on,
  sessionId, timezone}`. That starts `HandsFreeService` with
  `ACTION_CONVERSATION`: a microphone foreground service with its own
  notification, started from the person's tap and never remembered across
  visits. `DashboardActivity.onResume`/`onPause` set
  `HandsFreeService.pageVisible`. While it is true the service only waits
  (state `page`). While it is false it listens with `listen()`, sends
  `companion {handsFree: true, conversation: true}`, speaks with
  `AthenaVoice.playParts`, settles for 600 ms, and drops a turn that
  `Echo.isEcho`es her last reply. On going off screen,
  `HandsFreeClient.awaitPendingReply` speaks the answer to a person's message
  from the last 90 s that has no reply yet. On resume, `yieldToPage()` ends the
  service's open listen, and `listenForTurn` waits in 300 ms steps while
  `conversationBusy()`. The notification's Stop, or five quiet minutes off
  screen, sets `conversationEnded`; the next `conversationListen` then answers
  `{off: true}` (`ConversationOff`) and the page turns off without an error.
  `conversationStatus` lets a reloaded page pick a running conversation back up.
- No double voice: `HandsFreeService.status()` reports `mode` and `voiced` (the
  last 10 replies it spoke). `../../../companion/src/native/handsFree.ts` `phoneVoices(text)` makes
  `CompanionConsole` skip voicing a reply the phone spoke, or is about to
  (state thinking/speaking). `handsFreeRunning()` is true only for wake-word
  mode.
- Waiting lines: `../../../companion/src/athena/waitCues.ts` `useWaitCues`
  ("Hmm." at 1500 ms unless the server's filler came first, never over her,
  cancelled when `isThinking` ends). It is fetched with
  `useSpeech.warmFillers` when her voice is on. The service's `WaitCues` does
  the same in hands-free and locked conversation, and caches it with
  `AthenaVoice.prepare` at service start. The timed "Just a moment." at
  3000 ms was dropped by the owner on 2026-11-05.
- Lookup lines (2026-11-05): the server's filler comes from Jev's guess,
  `fillerLine(announce, fetch)` in `src/services/toolIntent.js`. One read Jev is
  sure of (SPEAK_AT 0.7) gets that source's `line`; two or more reads (any that
  start, FETCH_AT and up) get `MOMENT` "Just a moment."; none, or one unsure read, gets null and the client's
  "Hmm." covers it. The `memories` source is asked of adults only, is never a
  read (recall runs every turn), and counts as a lookup only when sure. The
  wording lives only on the server; the phone caches a new line the first
  time it hears it. Tests: `src/services/toolIntent.test.js`.
  Since 2026-11-05 it counts from the person's last word, not from the send.
  The phone side uses `HeardSoFar.changedAt()` into `WaitCues(t, from)`. The
  page gets `quietMs` on `conversationListen` and calls `markLastWords`.
  Counted from the send, "Hmm." came about 3.4 s after the last word.
- Car (2026-11-05): `../../../native-runtime/AndroidCompanion~/AthenaDashboard.androidlib/java/com/orcwood/athena/dashboard/CarAudio.java`.
  `HandsFreeService` holds it while conversation mode is
  on; with a connected `TYPE_BLUETOOTH_SCO` device whose Bluetooth class is car
  audio or hands-free (needs `BLUETOOTH_CONNECT`), it sets
  `MODE_IN_COMMUNICATION` and `setCommunicationDevice(car)`, and is `active()`
  once Android reports SCO as the communication device. Then `micSource()` is
  `VOICE_COMMUNICATION` (MicFeed, Vosk, enrollment) and `AthenaVoice` plays as
  `USAGE_VOICE_COMMUNICATION`. In the car the service always feeds the
  recogniser from MicFeed, and `pageHasConversation()` is false even on
  screen: `DashboardActivity` cancels the page's listen and sends
  `athena-native-pause`, and `status().car` makes `phoneVoices` true. The
  switch is `carAudioStatus` / `carAudioSet` (`CarConversation.tsx`). Earbuds
  never match, so runs keep the old path. Wake-word hands-free doesn't use the car.
- Dropped turns (2026-11-05): a conversation turn the phone heard and didn't
  send is reported to `/handsfree/turn` as `notYou` or `nothing`, with `car`
  and `voiceFilter {why, score, voicedMs}`; `path` is `conversation` or
  `conversationPickup`. A drive with nothing sent had left no trace at all.
  `src/controllers/handsFree.js`, test `handsFree.test.js`.
- Not yet: Guardians, barge-in outside desktop Chromium (including the phone
  with the screen off), lip sync with the screen off, knowing
  whether headphones are in, or superseding a reply still being written when
  they talk again.
