---
id: comet-catchers
title: Comet Catchers
summary: A play-together game for kids: lay the tablet flat between two people and catch comets as a team, or play with me; works offline.
where: Companion, signed in as a kid → Base → Bored? → Comet Catchers
status: partial
surfaces: [companion]
triggers: [comet catchers, comets, catch comets, play together, two player game, game we can play together, relay catch, constellations, sky map, stardust, meteor shower, golden comet, play with athena]
---

## What I can do

Comet Catchers is a game for two people on one tablet. Lay it flat between
you: **blue** guards the bottom edge and **gold** guards the top. Each player
slides a finger along their own edge to move their catcher.

- **Colours say whose comet it is.** Blue comets are the bottom player's, gold
  the top player's, white ones are anyone's. A comet often heads for the wrong
  player, who catches it to **pass** it across; when the partner catches the
  pass it's a **Relay**, worth the most. So you have to talk: "Yours!"
- **Stardust and combos.** Every catch is stardust. Catches in a row build a
  combo (×2 after 5, up to ×5), so a careful team scores far more than a rushed
  one. **So close!** shows a near miss.
- **Shields.** The team shares 3 shield lights. A missed comet costs one (and
  the sky goes quiet for a moment to recover); every 20 catches earns one back,
  up to 5. When they're gone the round ends, usually after a minute or two.
- **Surprises as you level up.** Golden comets worth five (level 2), twin
  comets that split in the middle, one for each player (level 3), and meteor
  showers full of easy comets (level 4); from level 6 the sky gets a little
  faster. 15 levels (Stargazer up to Master of the Sky); XP is the stardust you
  catch.
- **The sky map.** Stardust from every round lights up real constellations one
  star at a time: the Big Dipper, Cassiopeia, Orion, the Little Dipper, Cygnus,
  Leo, Lyra, Taurus, Gemini, Canis Major, Scorpius and Pegasus. Finishing one
  shows its shape and a true fact about it. The end of each round shows how
  many stars are left on the one you're working on.
- **Play with Athena.** Alone, a kid plays blue and I play gold. I catch most
  comets but not all of them, so the kid matters.
- It runs on the tablet: the sound is made on the device and progress is kept
  there, so it works with no internet.

There are no daily streaks, nothing to buy and no timers that push you to come
back. Finishing a constellation says it's a good place to stop.

## Where to find it

Signed in to Companion as a kid, **🎮 Bored?** on Base opens the games menu;
Comet Catchers is marked NEW. Choose **Play together** or **Play with Athena**.
⏹ ends a round early (the stardust still counts). On a computer, ←/→ move blue
and A/D move gold.

## When it doesn't work

- **A catcher won't move**: each finger steers the catcher on its own half of
  the screen. Start the touch on your side of the middle line.
- **No sound**: the tablet's sound is off (🔊 in the game, or Me → sound).
- **Progress went back to the start**: it lives on the tablet; another tablet
  or browser, or clearing its data, starts over.
- **It won't open with no internet**: open Companion once while online, signed
  in as the kid, so the game is kept on the tablet.

## Limits

- Two players on one tablet, or one player with me. It doesn't connect two
  tablets.
- Progress doesn't sync between tablets and isn't Guardian XP.
- Only on Companion in a web browser on the kid's tablet, not the Android app.

## Under the hood

**Never sent to a model.**

- Rules: `../../../companion/src/components/comet/engine.ts` — a pure step function (comets, catches, passes, relays, combos, shields, showers, twins, Athena's aim), tested in `../../../companion/scripts/comet.test.mjs`.
- Sky map: `../../../companion/src/components/comet/constellations.ts` (shapes, facts, star costs; `skyFor`, `finishedBetween`).
- Screen: `../../../companion/src/components/comet/CometCatchers.tsx` (+ `comet.css`): canvas drawing with pre-rendered glow sprites, two-finger input by half, Web Audio pentatonic sound, menu/over/sky screens, rendered in a portal. `COMET_LEVELS` is there. Progress in localStorage `game_xp_v1:comet:<uuid>`, `comet_stardust_v1:<uuid>`, `comet_best_v1:<uuid>`.
- Opened from the Bored? menu in `../../../companion/src/components/KidHome.tsx` (`onComets`), mounted in `../../../companion/src/pages/CompanionConsole.tsx` for kids.
