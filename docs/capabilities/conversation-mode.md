---
id: conversation-mode
title: Conversation mode
summary: In the chat on a computer you can leave the mic on and just talk with me, and cut in while I'm talking.
where: Chat → the ∞ button left of the mic (web browser, not the Android app)
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

While it's on, the button glows and lights up brighter whenever it hears you,
and what you're saying shows in the chat as you say it. It turns itself off
when you switch to another tab or after two quiet minutes.

## Where to find it

Open Chat in a web browser (Chrome works best). The ∞ button is to the left of
the mic, at the start of the message box. Tap it once to turn conversation
mode on, and again to turn it off. The first time, the browser asks to use
your microphone.

## When it doesn't work

- **It doesn't notice me talking.** It learns how loud the room is when you
  turn it on, so turn it on while things are quiet. A noisy room or music can
  hide your voice.
- **I stop talking when you didn't say anything.** On a laptop's speakers my
  own voice can reach the microphone. Headphones fix that.
- **"Couldn't reach speech recognition."** The browser's speech recognizer
  needs an internet connection. Typing still works.

## Limits

- Web browsers only. Not the Android app; on the phone, hands-free is the way
  to talk to me without touching anything. Firefox has no speech recognizer,
  so the button doesn't appear there.
- Turning your voice into words is done by the browser. In Chrome that means
  Google's servers. Your voice is only sent while it hears someone speaking,
  plus a few seconds after; silence and room noise stay on your computer. The
  sound itself never comes to me, only the words.
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
- Echo: final transcripts are dropped while she speaks and for 2 s after if
  `mightBeHer`. A finished turn is dropped if `isEcho` matches her reply from the
  last 15 s. The server refuses the same (`src/services/echo.js`).
- Tests: `../../../companion/scripts/conversation.test.mjs` and `echoGate.test.mjs` (`npm run test:speech`),
  `src/controllers/messageFiller.test.js`, `src/controllers/prompt.test.js`.
- Not yet: Guardians, the Android WebView (no `SpeechRecognition`), knowing
  whether headphones are in, or superseding a reply still being written when
  they talk again.
