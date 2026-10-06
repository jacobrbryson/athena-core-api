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

In the Android app you can turn on hands-free. Then you just talk to me —
"Athena, what time is it?" in one breath works, or say "Athena", wait for the
chime, and then ask. The screen can be off and the phone in your pocket. I answer out loud, into your earbuds if they're in, and turn your music
down while I talk. After I answer you get one follow-up without saying my name
again ("and tomorrow?"); after that I go back to waiting for my name.

It's built for being on the move — a run, a ride — so my answers are short and
spoken: no lists, nothing you'd need to look at.

When your question needs your calendar, WHOOP, email or heart rate, I
say so straight away — "Let me check your calendar, hmm…" — while I read it,
then answer. The first time a particular line comes up it's silent while the
phone saves my voice for it; after that it plays instantly.

The listening happens on the phone. Until it hears my name nothing is sent
anywhere, and after it only the words you said go to me — never the sound.
Recognising my name, and turning what you say next into words, both happen on
the phone.

While it's on, Android shows a notification saying I'm listening, the whole
time. That's how you always know. If you leave it on and it stops — the phone
restarted, Android closed the app — it comes back the next time you open me.
If something goes wrong in the middle of a question you hear a low tone and I
keep listening.

## Where to find it

In the Android app: the **⋯ menu** → **Phone & car** → **Hands-free** →
**Listen for "Athena"**. Android asks for the microphone the first time (and on
newer phones for notifications, so the listening sign can show). Stop it with
**Stop listening** in the same place, or from the notification.

Open the chat once on that phone before turning it on — hands-free joins the
same conversation.

## When it doesn't work

- **It doesn't react to my name.** Wind, heavy breathing and loud music make it
  harder; a quieter moment or earbuds with a mic help. Saying my name on its own
  and waiting for the chime is the most reliable way.
- **It heard me but didn't answer.** Signal on a trail drops; a low tone means
  I couldn't reach the server in time. I'm still listening — ask again when
  you're back in coverage.
- **"Open Athena and sign in again."** The phone's sign-in expired. Open the
  app and sign in; hands-free comes back on by itself.
- **It misheard what I said.** Some phones can't transcribe offline, and then a
  smaller offline model does it, which gets more wrong. The panel shows which
  one your phone is using.

## Limits

- Android app only — not the website, not iPhone.
- When you say it all in one breath, the question is transcribed by the
  smaller offline model, which gets more wrong than the phone's own recogniser.
  Pausing for the chime uses the better one where your phone has it.
- After a restart it waits for you to open the app — Android doesn't let an app
  start listening on its own in the background, and I wouldn't want it to.
- No signal means no answer — recognising my name works offline, answering
  doesn't.
- The "let me check…" line only names what I'm sure I'll need — at most two
  apps, plus your heart rate. I may quietly read a little more than I name.
- Heart-rate limit alerts are a separate switch — Phone & car → Heart rate
  (see heart-rate). They're spoken whether or not hands-free is on.

## Under the hood

- Native: `../../../native-runtime/AndroidCompanion~/AthenaDashboard.androidlib/java/com/orcwood/athena/dashboard/HandsFreeService.java`
  (microphone foreground service: energy gate → Vosk grammar `athena`/`hey athena`
  at conf ≥ 0.75; the utterance is buffered, so "athena <request>" in one breath is re-transcribed free-form and split after the last "athena" (≥ 2 words, else chime → Android on-device `SpeechRecognizer`, else Vosk free-form). A failed turn plays NACK and keeps listening; only sign-out/stop ends it. `enabled` pref + `resumeIfEnabled()` in DashboardActivity.onResume restarts it; PARTIAL_WAKE_LOCK while running;
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
- Filler: `HandsFreeClient.converse` sends `companion.filler: true`; `/message`
  returns `filler { key, text }` from `src/services/toolIntent.js` (Jev guess,
  ≤ 800 ms, adults only). `HandsFreeService.sayFiller` plays it from
  `AthenaVoice`'s text-keyed cache on its own thread while the reply is polled
  and voiced; an uncached line is fetched in the background (silent that
  once). The reply prompt gets `# Already said` so she doesn't repeat it.
- Prompt: `companion.handsFree` in `parseMessageContext` (`src/controllers/message.js`)
  → the HANDS-FREE rule in `buildAdultCompanionPrompt()`.
- Wake test (09-29, Windows SAPI voices, clean audio): 6/6 "Athena" phrases hit,
  0/10 negatives incl. "Arizona", "arena", "tuna", "Anthony and Tina". Real wind is untested.
