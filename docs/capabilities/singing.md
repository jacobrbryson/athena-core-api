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
lines. The words show up right away. A song takes me a moment to get ready, so
I'll say a quick word first while I warm up, then sing, usually about fifteen
seconds after you ask.

## Where to find it

Just ask me in the chat, for example "sing me a lullaby" or "sing happy
birthday to Sam". My voice has to be on: open the ⋯ menu (top right) and check
that Voice says on.

## When it doesn't work

- **You see the words but hear nothing.** My voice may be switched off. Turn
  it on under ⋯ menu → Voice and ask again.
- **I speak the song instead of singing it.** That happens if the chat has
  dropped to its backup connection. Ask again once it has reconnected.
- **I say I'm warming up, but the song never starts.** A song takes about
  fifteen seconds to prepare. If a minute goes by, my singing voice is
  unavailable right now; I can still say the words.

## Limits

- I sing without music: no instruments or backing track, just my voice.
- I won't sing copyrighted songs or write out their lyrics, so no current pop
  hits. I'm happy to write an original song in the same spirit instead.
- Songs are short, about four lines.
- I can't sing in a different voice, and I can't sing along with you in real
  time.

## Under the hood

**Never sent to a model.**

- Reply flag: `sing` in `RESPONSE_SCHEMA` and `SINGING_RULES` in `src/controllers/prompt.js` (child companion and adult companion strategies only; teach mode has no singing).
- Broadcast: `src/controllers/gemini.js` adds `sung: true` to the live `addMessage` rpc. It is not stored, so a reply reached through REST polling (or a poll that beats the socket) is spoken instead.
- Audio: `POST /api/v1/speech` with `{ text, style: "sing" }` in `src/controllers/speech.js`, then `llm.speech(text, { sing: true })` in `src/services/llm/router.js`, then `speech()` in `src/services/llm/adapters/gemini.js`. Same voice (`GEMINI_TTS_VOICE`, Aoede) on the `sing` model: `GEMINI_SING_MODEL`, defaulting to `gemini-2.5-pro-preview-tts`. Flash only reads in rhythm; Pro actually holds notes. Same access rule and 800-character cap as speech.
- Clients: `prepare(text, { sing })` in `../../../companion/src/athena/useSpeech.ts` and `../../../guardians/src/athena/useSpeech.ts` (75 s generation timeout), and the voice-hold gate in `../../../companion/src/pages/CompanionConsole.tsx` and `../../../guardians/src/pages/AthenaConsole.tsx`.
- Latency: ~14 s for four lines, ~25 s for eight (measured 2026-09-26). Sung replies are deliberately NOT held for their audio (spoken ones are, up to 20 s): the owner found a held song reply far too slow, so the lyrics show at once and playback starts when ready.
- Warm-up line: while the song generates, `prepare()` also fetches one of `SONG_INTROS` (spoken, fast model, ~3 s) and plays it first; the song follows when the intro ends. `ownerRef` drops the song if a newer reply, a cancel or Voice-off took the voice during the gap, so a late song never cuts in. The intro is voice-only; it is not in the transcript.
- The Android app bundles the companion web UI, so the phone only gets singing after an APK rebuild.
