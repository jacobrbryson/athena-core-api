---
id: hands-free
title: Hands-free on your phone
summary: On the Android app you can say my name and just talk — screen off, phone in a pocket — and I answer out loud.
where: the ⋯ menu (top right) → Phone & car → Hands-free (Android app only)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [hands free, hands-free, wake word, hey athena, say your name, always listening, listen for, while running, on a run, biking, mountain biking, earbuds, voice, talk to you without]
---

## What I can do

In the Android app you can turn on hands-free. Then you say "Athena", hear a
chime, and say what you want — the screen can be off and the phone in your
pocket. I answer out loud, into your earbuds if they're in, and turn your music
down while I talk. After I answer you get one follow-up without saying my name
again ("and tomorrow?"); after that I go back to waiting for my name.

It's built for being on the move — a run, a ride — so my answers are short and
spoken: no lists, nothing you'd need to look at.

The listening happens on the phone. Until it hears my name nothing is sent
anywhere, and after it only the words you said go to me — never the sound.
Recognising my name, and turning what you say next into words, both happen on
the phone.

While it's on, Android shows a notification saying I'm listening, the whole
time. That's how you always know.

## Where to find it

In the Android app: the **⋯ menu** → **Phone & car** → **Hands-free** →
**Listen for "Athena"**. Android asks for the microphone the first time (and on
newer phones for notifications, so the listening sign can show). Stop it with
**Stop listening** in the same place, or from the notification.

Open the chat once on that phone before turning it on — hands-free joins the
same conversation.

## When it doesn't work

- **It doesn't react to my name.** Say it on its own and pause — "Athena…
  (chime) what's next on my calendar". Wind, heavy breathing and loud music make
  it harder; a quieter moment or earbuds with a mic help.
- **It heard me but didn't answer.** Signal on a trail drops; the chime goes
  low when I couldn't reach the server in time. Ask again when you're back in
  coverage.
- **"Open Athena and sign in again."** The phone's sign-in expired. Open the
  app, sign in, and turn hands-free back on.
- **It misheard what I said.** Some phones can't transcribe offline, and then a
  smaller offline model does it, which gets more wrong. The panel shows which
  one your phone is using.

## Limits

- Android app only — not the website, not iPhone.
- You have to say my name, pause for the chime, then speak. Saying it all in one
  breath ("Athena what time is it") can lose the start of the question.
- It stops when you stop it, when you restart the phone, or if Android closes
  the app; it never turns itself back on.
- No signal means no answer — recognising my name works offline, answering
  doesn't.
- Heart-rate limits and alerts from a WHOOP aren't part of this yet.

## Under the hood

- Native: `../../../native-runtime/AndroidCompanion~/AthenaDashboard.androidlib/java/com/orcwood/athena/dashboard/HandsFreeService.java`
  (microphone foreground service: energy gate → Vosk grammar `athena`/`hey athena`
  at conf ≥ 0.75 → chime → Android on-device `SpeechRecognizer`, else Vosk free-form;
  never a cloud recogniser) and `HandsFreeClient.java` (the chat's own
  `POST /api/v1/message`, poll `GET /api/v1/message`, `POST /api/v1/speech`, with the
  WebView's `companion_session` cookie — no new route or credential).
- Model: `vosk-model-small-en-us-0.15` (Apache-2.0), fetched by
  `../../../native-runtime/Tools/Install-AndroidCompanion.ps1` with a pinned SHA-256
  into the androidlib's `assets/`; unpacked to app storage on first use.
- Panel: `../../../companion/src/components/HandsFree.tsx`; bridge calls
  `handsFreeStatus` / `handsFreeStart` / `handsFreeStop` in `DashboardActivity`.
  The open chat skips voicing replies while hands-free runs (`../../../companion/src/native/handsFree.ts`),
  or she'd speak twice.
- Prompt: `companion.handsFree` in `parseMessageContext` (`src/controllers/message.js`)
  → the HANDS-FREE rule in `buildAdultCompanionPrompt()`.
- Wake test (09-29, Windows SAPI voices, clean audio): 6/6 "Athena" phrases hit,
  0/10 negatives incl. "Arizona", "arena", "tuna", "Anthony and Tina". Real wind is untested.
