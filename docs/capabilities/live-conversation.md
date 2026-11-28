---
id: live-conversation
title: Live conversation
summary: Talk with me in real time — I answer in about a second, you can cut in, and I can look things up and do what you ask while we talk.
where: Chat → … input menu → Live conversation (beta, desktop browsers); on Android, say "Athena" with hands-free on
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [live conversation, live mode, real time, realtime, talk faster, faster voice, too slow, lag, delay, interrupt, talk over, cut in, voice chat, just talk, just do it, asking is approving, approve out loud, verbal approval]
---

## What I can do

Live conversation is the fast way to talk with me. Turn it on and the mic
stays open: you talk, and I usually start answering within about a second of
you finishing. You don't press anything between turns. Start talking while I'm
speaking and I stop straight away, so you can say "wait" or change the subject.

While we talk I can look things up for you: your calendar, your inbox, WHOOP,
your live heart rate if it's on, the weather somewhere, the web, and the home
cameras if you're allowed to see them. I only read what you've connected. I'll
say "one sec" or "let me look" and keep talking while I check, then tell you
what I found. I can check several things at once.

I can also do things you ask for while we talk: add to your calendar, send
something, set the thermostat — whatever I can normally do for you. Telling me
to do it is your approval, so there's no card to tap: I do it and tell you when
it's done. If I'm not sure what you mean, I ask first. Something I suggest
myself, I only do once you say yes.

When you're done, say goodbye or "that's all" and I end the conversation.

What we say is saved to the chat as we go: each exchange shows up once it
finishes, and what I'm hearing and saying shows in grey while we talk. It
counts like any other chat. I remember what matters from it, and if you stop
and start again I pick up where we were.

A small **Live: listening** indicator sits under the message box with a dot
that grows when it hears you, and the delay on the last answer next to it
(for example **0.8 s**). Tap it to stop.

## Where to find it

Open Chat in a desktop browser (Chrome or Edge work best). Open **Input**, the
**…** button to the left of **Tell Athena…**, and choose **Live conversation**.
Your browser asks once for the microphone. Choosing it again, or tapping the
indicator, turns it off. It also turns off when you switch to another tab, or
after two quiet minutes.

On the Android app, with hands-free on (Phone & car → Hands-free), saying
"Athena" starts a live conversation, even with the screen off. It ends when
you say goodbye or after ten seconds with nobody talking.

## When it doesn't work

- **It says it couldn't start:** the connection to my voice service failed.
  Try again in a moment; if it keeps failing, the older **Conversation mode**
  in the same menu still works.
- **I keep stopping mid-sentence on my own:** the mic is hearing my voice from
  your speakers. Headphones fix it, or turn the volume down a little.
- **I answered something you didn't say:** I misheard. The grey caption shows
  what I heard; just correct me.

## Limits

- It's a beta. On a computer it's in the browser; on the phone it's started by
  my name with hands-free on (the chat's Conversation mode there is the older one).
- Anyone near the microphone can ask me to do something. On the phone, with
  **Only my voice** on, I only act when it sounds like you; in the browser I
  can't tell voices apart.
- I can't sing in live conversation.
- My avatar doesn't move its lips during live conversation.
- Grown-ups only. Kids' sessions use the regular conversation mode.
- While it's on, what you say goes to Google (Gemini Live) as audio, not just
  as text, so my voice service can hear you directly.

## Under the hood

**Never sent to a model.**

- Backend: `src/services/live/index.js` (system instruction, locked config,
  `look_up` → `needs.clean`/`needs.fetch` up to `MAX_LOOKUPS` 6, `act` →
  `actions.attempt` + `actions.confirmVerbal` (approval `verbal`, owner
  2026-11-28; refused when no words were heard this turn), `end_conversation`
  handled by the client, look_up/act NON_BLOCKING with WHEN_IDLE results,
  `saveTurn` → `message` + `memoryStore.afterTurn`); token minting in
  `src/services/llm/adapters/gemini.js` `liveToken` (assertModelAccess first,
  one use, 1 min to start, 30 min life).
- Routes: `src/routes/live.js` → `POST /api/v1/live/session`, `/live/tool`,
  `/live/turn` (adult profile that owns or was admitted to the session; Guardian
  tokens refused).
- Frontend: `../../../companion/src/athena/liveConversation.ts` (raw WebSocket to
  `BidiGenerateContentConstrained` v1alpha, 16 kHz mic worklet, 24 kHz playback,
  interruption, reconnect on `goAway`, idle stop), `useLiveConversation.ts`, menu
  entry and indicator in `../../../companion/src/pages/CompanionConsole.tsx`.
- Android: `../../../native-runtime/AndroidCompanion~/AthenaDashboard.androidlib/java/com/orcwood/athena/dashboard/LiveSession.java` (see hands-free).
- Tests: `src/services/live/live.test.js`, `src/services/llm/liveToken.test.js`,
  `src/services/actions/actions.test.js` (confirmVerbal).
- Model: `GEMINI_LIVE_MODEL` (default `gemini-3.8-live`), voice `GEMINI_TTS_VOICE` (Aoede).
- Notes: `lockAdditionalFields: []` makes the API reject the token ("field_mask
  is invalid for BidiGenerateContentSetup"); leaving it unset locks the whole
  config, verified 2026-11-28 by a client setup that tried to swap the system
  instruction and tools and was ignored. Measured from the dev box 2026-11-28:
  token 0.24 s, socket+setup 0.45–0.67 s, text-in → first audio 0.58–1.2 s,
  streamed audio end of speech → first sound 0.83–1.3 s. Live's transcripts
  contain `<no speech>` / `{pause}` markers; both are stripped. No session
  resumption yet (whole config locked); reconnect mints a new token, and the
  saved turns carry the context.
