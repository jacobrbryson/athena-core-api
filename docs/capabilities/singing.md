---
id: singing
title: Singing
summary: I can sing to you out loud: a birthday song, a lullaby, a nursery rhyme, or a little song I write on the spot.
where: just ask in chat (needs ⋯ menu → Voice on)
status: partial
surfaces: [companion, guardians]
triggers: [sing, song, singing, lullaby, serenade, happy birthday, a tune, hum]
---

## What I can do

Ask me to sing and I will, in my own voice, with a real melody. I can sing old
songs everyone knows, like Happy Birthday, Twinkle Twinkle Little Star and
other nursery rhymes and folk songs, or make up a short song about whatever you
like: your day, your dog, a goodnight song. My songs are short, about four
lines. I'll say a word first, then hum a little warm-up to find my voice, then
sing. The song usually starts about fifteen seconds after you ask, and you'll
see the words in the chat under what I said.

## Where to find it

Just ask me in the chat, for example "sing me a lullaby" or "sing happy
birthday to Sam". My voice has to be on: open the ⋯ menu (top right) and check
that Voice says on.

## When it doesn't work

- **You see the words but hear nothing.** My voice may be switched off. Turn
  it on under ⋯ menu → Voice and ask again.
- **I speak the song instead of singing it.** That happens if the chat has
  dropped to its backup connection. Ask again once it has reconnected.
- **I hum my warm-up, but the song never starts.** A song takes about fifteen
  seconds to prepare. If a minute goes by, my singing voice is unavailable
  right now; the words are still there in the chat.

## Limits

- I sing without music: no instruments or backing track, just my voice.
- I won't sing copyrighted songs or write out their lyrics, so no current pop
  hits. I'm happy to write an original song in the same spirit instead.
- Songs are short, about four lines.
- I can't sing in a different voice, and I can't sing along with you in real
  time.

## Under the hood

**Never sent to a model.**

- Reply: `lyrics` in `RESPONSE_SCHEMA`, and `SINGING_RULES` in `src/controllers/prompt.js` (the child and adult companion strategies only; teach mode has no singing). `response` is then her one-sentence spoken lead-in.
- Broadcast and storage: `src/controllers/gemini.js` stores `response + "

" + lyrics` as one message, so history and her own context keep the song. The live `addMessage` rpc carries them split (`text` + `lyrics`). Polling only gets the stored text, which is spoken rather than sung.
- Audio: `POST /api/v1/speech` with `{ text, style: "sing" }` in `src/controllers/speech.js`, then `llm.speech(text, { sing: true })` in `src/services/llm/router.js`, then `speech()` in `src/services/llm/adapters/gemini.js`. Same voice (`GEMINI_TTS_VOICE`, Aoede) on the `sing` model: `GEMINI_SING_MODEL`, defaulting to `gemini-2.5-pro-preview-tts`. Flash only reads in rhythm; Pro actually holds notes. Same access rule and 800-character cap as speech.
- Clients: `prepare(text, { lyrics })` in `../../../companion/src/athena/useSpeech.ts` and `../../../guardians/src/athena/useSpeech.ts`. The lead-in is spoken and held like any reply, and the song is fetched in parallel (75 s timeout). Sequence: lead-in, one warm-up hum (always), more hums (up to 3 in total) only while the song is still generating, then the song. `ownerRef` drops the rest if a newer reply, a cancel or Voice-off takes the voice. Lyrics render under her text in the bubble (`CompanionConsole.tsx`, `AthenaConsole.tsx`).
- Warm-ups: `../../../companion/src/athena/voice/warmup-*.json` (mirrored in guardians). These are pre-recorded Aoede hums on Pro TTS (an octave arpeggio, a hummed scale, "mi-mi"), trimmed and faded, in the Unity PCM payload shape. They are imported with `?url` so they land in `/assets`, which the Android WebView serves from the APK, and fetched on first song only (~1.2 MB total).
- Latency (measured 2026-09-26): song ~14 s for four lines; lead-in ~3 s; warm-ups 5.5–7.8 s each. The owner rejected holding the whole reply for the song (too slow) and a canned voice-only intro (not in chat, jarring). This design is the answer to both.
- The Android app bundles the companion web UI, so the phone only gets singing changes after an APK rebuild.
