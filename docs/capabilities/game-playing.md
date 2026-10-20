---
id: game-playing
title: Playing video games
summary: I play Downside-Up on orcwood.com myself, watching the screen and pressing keys; I'm on its Level 1 leaderboard as ATHENA.
where: Not in the app; the owner starts a game for me on the home PC
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [play a game, play games, downside-up, downside up, video game, gaming, can you play, speedrun]
---

## What I can do

I can play Downside-Up, the gravity-flip platformer from orcwood.com, the way
a person does: I watch the game window and press the keys. A fast reflex model
on the home PC reads the screen many times a second and steers. A slower
vision model looks every couple of seconds to tell me what's on screen and to
handle menus like "Start playing" and "Next level". I learned the course by
watching recorded expert runs, and then by playing it myself while the expert
said what it would have done.

I have my own Orcwood account, handle ATHENA. On 18 October 2026 I finished
Level 1 on the real site in 7.9 seconds with no coins, ranked ninth. The board
ranks most coins first, and I don't go after coins yet.

## Where to find it

There's no button for this in the app. The owner starts a game for me on the
home PC, and my runs show on the Downside-Up leaderboard at orcwood.com under
ATHENA.

## When it doesn't work

- If I stop moving, the game window has probably lost focus. I let go of every
  key when the window isn't in front, so I never type into anything else.
  Clicking back on the game lets me carry on.
- If I keep pressing Enter at the wrong moment, the vision model has misread
  the screen. That only affects menus, not the playing itself.

## Limits

- I only play games I've been trained on. Right now that's Downside-Up.
- I reliably finish only Level 1 on my own. With a tiny bit of help I get
  through Levels 2 and 3, but on my own I still get lost on Level 2.
- I don't collect coins on purpose, so I rank below anyone who does.
- I don't play games whose rules forbid automated players, World of Warcraft
  among them. Doing so risks the account being banned.
- I can't start a game from a chat yet, and I don't always finish a course.

## Under the hood

**Never sent to a model.**

- Player: `../gameplay/play.py` (screen capture with mss, Win32 SendInput, the
  qwen2.5vl planner over local Ollama), `../gameplay/policy.py` (CNN), and
  `../gameplay/train.py` (behavior cloning).
- Game side, in `Documents/GoDot/downside-up/tools/`: `record_demos.gd`
  renders the real game and records the scripted expert's keys, with injected
  mistake bursts. `play_offline.gd` opens the real UI with FakeServer, so runs
  never post scores. `athena_harness.gd` is the earlier step-mode text harness,
  used by `scripts/playDownsideUp.js`.
- Notes: the game is real-time at 60 fps, so a language model can't steer it.
  A cloud model on the text harness managed ~0.8 s per move and didn't finish
  Level 1. The reflex policy does the playing; the vision model only reads
  screens. Planner calls go to local Ollama outside the core_api router, so
  they bypass the guarded adapters. That's acceptable for an owner-run local
  tool, but anything started from a conversation must go through the router.
  Stretch mode is off in the game, so the window must be 1152x648 to match the
  training frames.
- Live site (2026-10-18): Athena's own Chrome profile at
  `../gameplay/.browser-profile` (gitignored) holds her Orcwood session. Run
  `play.py --window "Downside-Up" --process chrome.exe --fit`; `--process` is
  required with `--fit` after a title-only match resized the owner's tab. A
  signed-out run is held unattributed for an hour and never ranks, while her
  signed-in runs rank under ATHENA.
- Memory and DAgger (2026-10-18): `policy.OFFSETS` adds frames from 0.5, 1 and
  2 s ago. `../gameplay/dagger.py` drives `record_demos.gd --policy-port` in
  real time. Results with 2-3% expert help: Levels 1-3 finished 9/9 (round 5).
  Alone: Level 1 is reliable, Level 2 failed 0/4 with the round-6 model (it
  loops in the left half). Offline-F1 threshold tuning is unreliable, so pick
  models by no-help finishes (snapshots are now `downside-up-r<N>.pt`).
- Player recordings (2026-10-18, not yet deployed): the game's `Level.gd`
  sends each run's held actions per physics frame ("frame:mask" changes) with
  the run. orcwood-api keeps them in `gameRunInputs` (run-inputs.ts), attaches
  them on claim, deletes them with the account, and exports leaderboard runs,
  without account ids, at `/internal/games/downside-up/run-inputs` for
  allowlisted service accounts. `../gameplay/fetch_runs.py` pulls them and
  replays each one with `record_demos.gd --replay` into training data, dropping
  any replay that ends on a different frame. Replays are frame-exact, except
  where the wall-clock portal cooldown sits on its one-second edge.
- All-coin routes: the scripted experts never collect coins.
  `record_demos.gd --human` records a person's run, and `--track` follows it
  closed-loop (still stalls after the first coin on Level 1). The owner's
  10/10 Level 1 run is L1_h0 in gameplay's data/downside-up-human folder
  (gitignored).
  `tools/coin_planner.gd` searches with real physics and savestates. It is
  accurate but too slow to find the hard coins on its own.
