---
id: collections
title: Lists and trackers I keep for you
summary: I can start a list or tracker for anything you want kept — a Christmas list, birthdays, a packing list, a maintenance log — and show it on Home.
where: Ask me in chat; the list shows as a card on the Companion dashboard Home, and on each person's page under Family
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [christmas list, gift ideas, gifts, presents, birthday list, wish list, wishlist, packing list, start a list, keep a list, keep track of, tracker, log, checklist, check off, what we bought, collection]
---

## What I can do

When you ask me to keep track of something, I start a list for it — no update
to the app needed. A list about people, like a Christmas list, has an entry for
each person: I start with the people I know should be on it, ask who else, and
fill in ideas from what you've told me about them and from the interests on
their page, plus a few ideas of my own. Things I find are marked as
suggestions until you keep them.

You can tell me what you bought ("we got Skylar the horse book"), add or drop
ideas, tick people off when they're done, or ask me to add someone. When you
mention something in conversation that belongs on a list — "Thomas is really
into the stars lately" — I add it as a suggestion. A list with an end date,
like a Christmas list ending December 26, leaves Home by itself afterwards and
is kept in case you want it next year.

## Where to find it

Ask me in chat: "Start a Christmas list for the family." The list appears as a
card on the Companion dashboard Home. Tap a person on the card to open their
page under Family, where their ideas are listed with **Keep** for my
suggestions, a status for each idea, **Tell me more** to tell me about them,
and **Add an idea**. The checkbox beside each person on the card ticks them
off.

## When it doesn't work

- **I don't know who someone is.** I only put people on a list who are in your
  family memories or on the family's profiles. Tell me about them first, and
  I'll ask which one you mean if two people share a name.
- **My suggestions are thin.** I can only suggest from what I know. Tell me
  more about the person, or add interests on their page.
- **A change asks for approval.** Starting or ending a list always asks you
  first. Adding, changing and removing items asks too, unless you've given me
  standing approval for those in Actions & permissions.

## Limits

- I don't read your text messages for lists yet — only our conversations and
  what you've told me.
- I can't buy anything, and I don't look up prices or stores for you.
- A list can hold text, numbers, prices, dates, yes/no, choices and links —
  not photos.
- Removing something hides it with an undo for 30 days; it isn't deleted
  straight away.

## Under the hood

**Never sent to a model.**

- Design: claude.ai/artifact/HiT81qEfBoXFBpQRpUNCNG (owner, 2026-11-28) — collections defined as data, no code per list.
- Backend: `src/services/collections/index.js` (definitions, items, reads, prompt block, nightly sweep), `src/services/collections/actions.js` (define_collection, add_item, update_item, remove_item, archive_collection — owner-authorized 2026-11-28; only the three item actions may be standing), `src/services/collections/capture.js` (backfill on create, suggestions from adult chat turns), `src/services/entities/index.js` (who-do-you-mean lookup + confirmed aliases).
- Wiring: `src/services/actions/registry.js` (ACTIONS + PARAM_TYPES), `src/controllers/gemini.js` (collections prompt block; capture after the reply), `src/jobs/nightly.js` (collectionsSweep), `src/services/personUpdate.js` (confirmed aliases win).
- Routes: `src/controllers/collections.js`, `src/routes/companion.js` — `GET /api/v1/dashboard/collections`, `/collections/:uuid`, `/collections/person/:key`, `POST /collections/subjects/:uuid/done`, `PATCH|DELETE /collections/items/:uuid`, `POST /collections/items/:uuid/restore`.
- Data: migration `db/migrations/0130_collections.up.sql` (athena_collection, athena_collection_subject, athena_collection_item, athena_entity_alias).
- Frontend: `../../../companion/src/components/Collections.tsx` (Home card + person panel), `../../../companion/src/api/collections.ts`, mock `../../../companion/mock/collections.ts`.
- Tests: `src/services/collections/collections.test.js`.
- Notes: items whose source memory was forgotten are hidden at read time (join in `itemsOf`). People are keyed like the Family roster: a user_memory uuid or `child:<uuid>`. Texts are off for capture (owner, 2026-11-28).
