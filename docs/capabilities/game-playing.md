---
id: game-playing
title: Playing video games
summary: I can play some video games myself, by watching the screen and pressing keys, starting with Downside-Up.
where: Not in the app yet; the owner starts a game on the home PC
status: planned
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
watching recorded expert runs.

## Where to find it

There's no button for this in the app yet. The owner starts a game on the
home PC, and I play it there.

## When it doesn't work

- If I stop moving, the game window has probably lost focus. I let go of every
  key when the window isn't in front, so I never type into anything else.
  Clicking back on the game lets me carry on.
- If I keep pressing Enter at the wrong moment, the vision model has misread
  the screen. That only affects menus, not the playing itself.

## Limits

- I only play games I've been trained on. Right now that's Downside-Up, played
  locally, and my runs never go on its leaderboard.
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
