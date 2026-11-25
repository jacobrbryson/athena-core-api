---
id: piano-quest
title: Piano Quest
summary: A game for kids that teaches reading piano sheet music, with levels, new notes, the bass clef and songs; it works with no internet.
where: Companion, signed in as a kid → Base → Bored? → Piano Quest
status: partial
surfaces: [companion]
triggers: [piano quest, piano, piano game, sheet music, read music, reading music, music notes, notes on the staff, treble clef, bass clef, middle c, every good boy does fine, face, all cows eat grass, play a song, music game, learn piano]
---

## What I can do

Piano Quest teaches the Guardians to read piano sheet music. A note sits on
the staff and they tap its key on the piano at the bottom of the screen.

- **New notes one at a time.** Each new note gets its own introduction: "This
  note is G — tap the glowing key." Then a round of ten notes to read alone.
- **Levels.** There are 15 levels with names (Note Newbie up to Piano Legend).
  Level 1 is middle C, D and E; then F and G; then A, B and high C; then the
  letters leave the keys; then notes up to high G; then the bass clef; then
  low notes down to G; then both clefs mixed; and from level 9 quick answers
  earn a speed bonus. A LEVEL UP! banner says what's new.
- **XP.** Every right note earns XP, double with the letters hidden (🙈), plus
  a combo bonus for a streak (🔥), a bonus for each finished round and more for
  a perfect one. XP is the game's own and stays on the tablet, per kid; it isn't
  Guardian XP.
- **Help when they're stuck.** A wrong key still plays its sound. After one
  miss they get a tip: the memory sentences for lines and spaces (Every Good Boy
  Does Fine, FACE, Good Boys Do Fine Always, All Cows Eat Grass). After two, the
  right key glows. Middle C always has a little dot on its key.
- **Songs.** 🎵 Songs lists old favourites, each unlocked once they can read all
  its notes: Hot Cross Buns at level 1, then Mary Had a Little Lamb, Ode to Joy,
  Jingle Bells, When the Saints Go Marching In, Twinkle Twinkle Little Star,
  London Bridge, Row Row Row Your Boat, and two low ones for the bass clef. The
  notes scroll along the staff, each right key plays the next note of the tune,
  and at the end the whole song plays back. A song they've finished gets a ⭐.
- It all runs on the tablet: the piano sound is made on the device, so it
  works with no internet, like Signal Relay.

## Where to find it

Signed in to Companion as a kid, Base has a **🎮 Bored?** button at the top.
It opens a menu: **Signal Relay**, **Piano Quest** and **Secret messages**. In the game, 🏠 goes back to its
menu, 🔤/🙈 shows or hides the letters on the keys, 🔊 is the sound, and ✕ goes
back to Base. A real keyboard's A–G keys work too.

## When it doesn't work

- **It won't open with no internet**: the tablet has to open Companion once
  while online, signed in as the kid, so the game is kept for later.
- **No sound**: the tablet's sound is off (🔊 in the game, or Me → sound).
  The keys still light up.
- **Their level went back to 1**: progress lives on the tablet. A different
  tablet or browser, or clearing its data, starts over.
- **The clef looks like a box**: the tablet's fonts don't have the music
  symbol. The words "treble clef" or "bass clef" under it still say which.

## Limits

- White keys only: no sharps, flats, key signatures, or rhythm reading. Songs
  play with their rhythm at the end, but the kids only read which note.
- Progress doesn't sync between tablets and doesn't count toward Guardian XP.
- It only works on Companion opened in a web browser on the kid's tablet, not in
  the Android app yet.
- I can't hear a real piano; they play on the screen.

## Under the hood

**Never sent to a model.**

- Game: `../../../companion/src/components/piano/PianoQuest.tsx` (+ `piano.css`): synthesized piano (`usePiano`, Web Audio), SVG staff, on-screen keyboard. `PIANO_LEVELS` and the XP amounts are there.
- Notes, staff positions, ledger lines, level note sets, rounds, keyboard range and songs: `../../../companion/src/components/piano/notes.ts`, tested in `../../../companion/scripts/piano.test.mjs`.
- Levels and XP: `../../../companion/src/components/games/progress.ts` and `../../../companion/src/components/games/GameXp.tsx`, localStorage `game_xp_v1:piano:<profile uuid>`; notes already introduced in `piano_seen_v1:<uuid>`, finished songs in `piano_songs_v1:<uuid>`, the letters choice in `piano_labels_v1:<uuid>`.
- Opened from the Bored? picker in `../../../companion/src/components/KidHome.tsx` (`onPiano`), mounted in `../../../companion/src/pages/CompanionConsole.tsx` for kids only.
- Offline: part of the main bundle, so the kid-only cache in `../../../companion/public/athena-sw.js` keeps it with the rest of the app.
