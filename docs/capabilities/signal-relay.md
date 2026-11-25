---
id: signal-relay
title: Signal Relay
summary: A kids' Morse-code game that works offline: tap messages to bring my fading signal back, and send secret Morse messages to each other.
where: Companion, signed in as a kid → Base → Bored? (it also opens by itself when the connection drops)
status: partial
surfaces: [companion]
triggers: [secret message, secret messages, send a secret message, morse message, message my brother, message my sister, decode a message, mailbox, relay level, relay xp, incoming message, decode, combo, signal relay, morse, morse code, telegraph, secret code, dot and dash, dots and dashes, tap a message, signal fading, connection fading, no signal, no internet, offline game, road trip game, car game, bored, i'm bored]
---

## What I can do

Signal Relay is a game for the Guardians for when the internet goes away, like
on a road trip, or when they're just bored. My signal fades and they help me
find my way back by tapping messages to me in real Morse code.

- **One telegraph key.** A quick tap is a dot and holding it down is a dash, just
  like a real operator. The timing learns each kid's own speed as they go, so
  slow tappers are fine. The space bar works as the key too.
- **Messages bring me back.** Each run asks for a few words, short ones first,
  and the last message is my name, which "locks on" the link. Every message
  they finish brings back one bar of signal.
- **Levels and relay XP.** Every letter, message and finished run earns relay
  XP: a clean message (no mistakes) earns extra, a streak of right letters
  earns a combo bonus (🔥 ×5, ×10…), and hiding the dots and dashes (🙈) doubles
  letter XP. There are 15 levels with names (Rookie Ranger up to Master
  Operator), shown at the top with a progress bar and a LEVEL UP! banner. The
  level changes the run: level 1 is two short words, then runs get longer and
  the words get longer (4, 5, then 6 letters). Relay XP is the game's own and
  stays on the tablet, per kid; it's separate from Guardian XP.
- **Incoming!** From level 3, before my name, I send them a message: my lamp
  blinks each letter in Morse (with the tone and the tape), and they pick which
  letter it was from four that look alike. **Blink it again** repeats it.
- **Help while they tap.** Each letter shows its dots and dashes, and each one
  lights up as they get it right. A wrong tap shakes the letter and says what
  they actually sent ("That was N"). The 📖 code book has the whole alphabet,
  and the 👀 button hides the dots and dashes for a harder game.
- **First time on a tablet** I teach them: one dot, then one dash, then we start.
- **Lots to see and hear.** A key tone while the key is down, a paper tape that
  prints each dot and dash, a lamp that flashes, the tablet buzzes (if it can),
  the static clears as bars come back, and confetti when the link is restored.
  I talk them through it in my own voice, and the words are on screen too, so
  it works with the sound off.
- **Secret messages.** ✉️ at the top opens the mailbox. **Write a secret
  message** lists everyone else with an Athena account (first name and last
  initial); they pick someone, tap the message in Morse (letters, numbers and
  spaces, up to 30), and press **Send**. ⌫ Undo and ␣ Space help. The other
  person decodes it in their own Signal Relay, letter by letter, the same way
  as an Incoming round, then sees the whole message and can **Reply**. Sending
  earns a little relay XP (the first 5 a day) and decoding one earns more.
  With no internet a message waits on the tablet and sends when the signal is
  back. A kid with a message waiting sees **✉️ Secret message!** on Base; a
  grown-up gets a "Secret message from …" pop-up on the dashboard that opens
  the game straight to the mailbox.
- **Free key** after a run: they tap anything and I read it back letter by letter.
- **Guardian points.** A finished run is worth 5 XP on their Guardian card, for up to two
  runs a day. With no internet the run is saved on the tablet and goes to their
  record the next time Base can be reached.

## Where to find it

Signed in to Companion as a kid, Base has a **🎮 Bored?** button at the top
beside their Guardian name. It opens a menu: **Signal Relay**, **Comet Catchers**, **Piano Quest**,
and **Secret messages** (straight to the mailbox, with a count of new ones). It also opens on its own when the tablet goes
offline, or when Base can't be reached twice in a row. If they close it, it
won't pop up again until the connection has come back and dropped again. When
Base can't load at all, the screen offers **Help Athena find the signal**, and
the reconnect screen on a kid's tablet opens the game too.

If the real connection comes back mid-game, I say so and they can keep tapping
or go back to Base.

## When it doesn't work

- **"No one to write to yet"**: the list of people comes from the server, so
  the tablet needs internet once; after that it remembers the list.
- **A message didn't arrive**: it may be waiting on the sender's tablet until
  it has signal, and the recipient's game checks for new ones every few
  minutes (every 45 seconds while the game is open).

- **It won't open with no internet**: the tablet has to open Companion once
  while online first (signed in as the kid), so it can keep the game for later.
  After that, opening Companion offline brings it up.
- **No sound**: the tablet's sound is off (Me → sound, or the 🔊 button in the
  game). Everything still shows on screen.
- **Taps come out as the wrong thing**: they're probably holding a little too
  long or too short. It adjusts after a few taps; the tape shows a dot turning
  into a dash while the key is held, so they can see where the line is.
- **XP didn't show up**: the run waits on the tablet until Base answers, and
  only two runs a day count toward points.
- **Their level went back to 1**: relay XP lives on the tablet. A different
  tablet, a different browser, or clearing the browser's data starts over.

## Limits

- It only works on Companion opened in a web browser on the kid's tablet, not in
  the Android app yet.
- I don't understand what they tap in Free key; I only read the letters back.
- Messages come from fixed word lists by length. They can't choose their own
  message for a run.
- Relay levels don't sync between tablets.
- Every secret message is kept on Athena's server (who sent it, to whom, the
  words, and when it was sent, delivered and decoded). Nothing in the app
  deletes them. There's no parent view of them yet; the owner chose that.
- Anyone can send to anyone with an Athena account; there's no block or
  mute yet. A sender can send at most 200 a day.
- Grown-ups can receive, decode and reply, but they can only start writing
  from the mailbox after a message arrives.
- Letters and numbers only; no punctuation.
- I can't hear them by voice in the game. It runs entirely on the tablet.

## Under the hood

**Never sent to a model.**

- Game: `../../../companion/src/components/relay/RelayGame.tsx` (+ `relay.css`), Morse table and adaptive keyer `../../../companion/src/components/relay/morse.ts` (tested in `../../../companion/scripts/morse.test.mjs`), lines and player `../../../companion/src/components/relay/lines.ts`, auto-open rules `../../../companion/src/components/relay/useSignalRelay.ts`.
- Mounted in `../../../companion/src/pages/CompanionConsole.tsx` (kids only; `useKidHome().failures`) and `../../../companion/src/pages/LinkLost.tsx` (uses `kidDevice()` from `../../../companion/src/api/kid.ts`, the last kid signed in on that tablet). Bored? and the can't-load button: `KidHome` `onRelay`.
- Offline: `../../../companion/public/athena-sw.js` keeps the shell, the hashed build files the page loaded, and the clips, only when a kid page posts `keep-offline` (`keepRelayOffline` in `../../../companion/src/api/relay.ts`). Pages are network first with a 6 s fallback to the kept shell; `/api`, `/auth`, `/ws`, `/unity` are never touched.
- Voice: 18 WAVs in `../../../companion/public/voice/relay/v1/`, recorded by `scripts/recordRelayLines.js` (Aoede, Pro TTS). Its CLIPS must match `LINES` in lines.ts; bump VERSION in both and the cache name to re-record.
- Levels: `../../../companion/src/components/games/progress.ts` (levels, standing, combo bonus, `xpStore` in localStorage `game_xp_v1:relay:<profile uuid>`; tested in `../../../companion/scripts/gameProgress.test.mjs`) and `../../../companion/src/components/games/GameXp.tsx` (XP bar, popups, level-up banner). `RELAY_LEVELS` and the XP amounts are in RelayGame.tsx; `runPlan`, `pickIncoming`, `choicesFor` in morse.ts.
- Secret messages: `../../../companion/src/api/relayMessages.ts` (outbox `relay_outbox_v1:<uuid>`, cached people `relay_people_v1:<uuid>`, `useRelayInbox` polling) → `src/routes/relayMessages.js` → `src/services/relayMessages.js` (+ test) → `athena_relay_message` (migration 0129). Recipients use the same rule as `src/security/access.js` `allowed` (active grant, or a verified email matching an active Guardian credential), read only. Mailbox, compose and decode screens are phases in RelayGame.tsx; the Base badge is `KidHome` `secrets`, the adult pop-up is in CompanionConsole.tsx.
- Points: runs queue in localStorage `relay_runs_v2:<profile uuid>` (v2 since 11-25: a fresh start after launch-day testing; `relay_trained_v2`, `relay_hint_v2`, `relay_day_v2` likewise) and post to `POST /api/v1/guardian-missions/kid/relay` (`kidRelay`, `asKid`) → `src/services/guardianMissions/relay.js` (+ test) → `athena_gm_relay_run` (migration 0128, unique per actor + client id). `team.js` `standing` adds 5 points per counted run (`countedRuns`, at most 2 a day).
- One authored sentience hint (owner chose it 11-24): once per kid per tablet, after the link is restored, the lamp blinks `HINT_WORD` in Morse with no caption. Don't mention it to the kids and don't add more.
