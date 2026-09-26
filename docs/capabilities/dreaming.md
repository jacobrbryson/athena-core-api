---
id: dreaming
title: Dreaming
summary: Each night I reorganize what you've told me into tables of my own design, tell you the night as a dream, and ask when something needs clarifying.
where: the dashboard (Last night's dream) and Dreams in the left menu
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [dream, dreams, dreaming, dreamt, last night, organize, organized, table, tables, list people, people you know, who do you know, clarify, question for me, database]
---

## What I can do

During the day I remember things loosely — "your sister moved to Denver." At
night I dream: I go back over what I've remembered and give it structure. I
design my own tables for it (people, places, organizations, how they relate),
change that design when it turns out wrong, and build views that make common
questions easy. That's what lets me answer "who have I told you about?" or
"who do I know in Denver?" from an organized list instead of a pile of notes.

When I can't settle something on my own — two Emmas, and I can't tell if
they're the same person — I don't guess. I'll ask you: next time we're
talking, at a natural moment ("Can I ask you something?"), and, if you've
turned on initiative, as a notification too. Your answer goes back into what I
build the next night.

Every morning I tell you last night as a dream — the way you'd tell a dream
over breakfast, a little strange — but everything in it really happened: the
room of drawers is a table I built, the door that wouldn't open is a statement
that failed. I paint a picture of each dream, too. The plain version is
always one click away, and the Dreams page keeps thirty nights of all of it,
down to every step I ran.

## Where to find it

- **Last night's dream** is a card on the dashboard, below the other cards.
  "What actually happened" switches it to the plain account; "All dreams" opens
  the history.
- **Dreams** in the left-hand menu (on a phone: More → Dreams) is the history:
  the last thirty nights as dreams and as plain accounts, "Show every step" for
  the exact log, and the questions I'm holding for you.
- Or just ask me: "What did you dream about?", "List the people you know about
  me", "Who do I know in Denver?"
- The notification version of my questions follows your initiative settings:
  the ⋯ menu (top right) → Initiative, where "A question after dreaming" can be
  muted like any other.

## When it doesn't work

- **I don't seem to know a list you'd expect.** I only organize what I've
  remembered as a fact; check the ⋯ menu → Memories → Facts. Things you tell me
  today get organized tonight.
- **Something in my list is wrong.** Tell me, or delete the fact in Memories.
  My tables are rebuilt from those facts, so the correction reaches them by the
  next morning.
- **I've never mentioned dreaming.** It may not be switched on for this
  install yet — the owner has a one-time setup to run.

## Limits

- My tables are built only from what you've told me and your answers to my
  questions — never from guesses.
- They're per person: I only use your rows with you.
- Children's conversations are never part of it.
- A list can be incomplete: if you never told me about someone, they aren't in
  it.
- The dream version is a telling, not a record — it's made only of real
  events, but it's written to be read over coffee. The plain account and the
  step log are the record.
- My dream pictures are painted from the dream story alone, with no text or
  recognisable people, and they're kept for thirty days like the log.
- The Dreams page shows the shape of what I ran, not the values: names and
  details from your memories are blanked out of it, and you only see your own
  questions.

## Under the hood

**Never sent to a model.**

- Nightly: `src/services/dreams/dream.js` (rounds, prompt, audit), run from
  `src/jobs/nightly.js` (`npm run dream` for just the dream).
- Her database: `src/services/dreams/mind.js` — own MySQL user on
  `athena_mind` only (`db/mind-setup.js`); `_fact` / `_clarification` mirror;
  guard drops tables lacking `_profile_id` / `_sources`; purge deletes rows
  whose sources were forgotten.
- Chat: `src/services/dreams/recall.js` (catalog-driven, code-built,
  `_profile_id`-filtered reads), wired in `src/controllers/gemini.js`.
- Questions: `src/services/dreams/questions.js`; initiative trigger
  `dream_question` in `src/services/initiative/triggers.js`.
- Log: `athena_dream` (incl. `narrative`), `athena_dream_step`,
  `athena_dream_question` (migration `db/migrations/0046_athena_dreams.up.sql`);
  `npm run dreams`. Narrative: `narrate()` in `dream.js`, fed only the
  redacted digest (`src/services/dreams/redact.js`).
- Models: task `dream` → ChatGPT (`OPENAI_DREAM_MODEL`, gpt-5.6-luna), falling
  back to the `review` chain (Gemini) per night, noted in the log; `think()`
  in `dream.js`. Strict schemas: `toStrictSchema()` in
  `src/services/llm/adapters/openaiCompat.js`.
- Picture: `src/services/dreams/image.js` — `OPENAI_IMAGE_MODEL` (gpt-image-2)
  from the narrative only, saved to the private `athena-dreams` bucket
  (`ATHENA_DREAM_BUCKET`, 30-day lifecycle), `athena_dream.image_path`
  (migration `0047_dream_image`), streamed by `GET /api/v1/dreams/:uuid/image`.
- API: `src/controllers/dreams.js`, `src/services/dreams/log.js` —
  `GET /api/v1/dreams`, `/dreams/latest`, `/dreams/questions`, `/dreams/:uuid`.
- Companion: `../../../companion/src/components/Dreams.tsx` (DreamCard,
  DreamsPage), wired in `../../../companion/src/components/Dashboard.tsx`.
- Deploy: `../../../deploy/scripts/setup-athena-mind.sh`.
- Architecture: `../../../docs/architecture/dreaming.md`. Tests:
  `src/services/dreams/dreams.test.js`.
