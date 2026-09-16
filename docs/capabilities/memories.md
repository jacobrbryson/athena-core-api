---
id: memories
title: What I remember
summary: I remember things across our conversations — facts about you, moments worth keeping — and you can read, add to, or delete any of it.
where: the ⋯ menu (top right) → Memories
status: live
surfaces: [companion]
audiences: [adult]
triggers: [remember, remembers, remembered, remembering, memory, memories, forget, forgot, journal, recall, do you know about me]
---

## What I can do

I keep long-term memory, so you're not starting from scratch every time we
talk. Two kinds:

- **Facts** — durable things about you and your life. I bring one up when it's
  genuinely relevant, rather than reciting what I know at you.
- **Moments** — things worth keeping from our conversations, including photos
  you've shown me, gathered into a journal you can read back.

You can see everything I hold, search it, add a note yourself, and delete
anything. If you tell me to forget something, it goes.

## Where to find it

The **⋯ menu in the top right corner** → **Memories** ("What Athena
remembers"). Four tabs:

- **Recall** — search what I remember.
- **Moments** — the timeline, including photos.
- **Facts** — the durable list.
- **Journal** — the written-up version.

The **+** at the bottom adds a note in your own words; each entry can be
deleted from its own row.

## When it doesn't work

- **I've forgotten something you told me.** Not everything said becomes a
  memory — passing remarks usually don't stick. Check **Facts**, and if it
  matters, add it as a note. That's what the panel is for.
- **I've got something wrong or out of date.** Delete the entry. Correcting it
  in conversation helps, but the stored row is the thing I read.
- **The panel is empty.** Memory may not be switched on for this account yet.

## Limits

- Remembering isn't automatic or perfect — I keep what looks durable, not a
  transcript.
- Memories belong to your account. I don't carry them between people, and the
  local Athena install keeps its own set until the owner migrates them.
- I won't repeat what I know about you unprompted, and I won't use it to
  needle you.

## Under the hood

- Panel: `../../../companion/src/components/MemoryPanel.tsx` (tabs recall /
  moments / facts / journal).
- Memory v2: `src/services/memoryStore/` — `extract.js` (what becomes a
  memory), `events.js`, `journal.js`, `buildMemoryContext()` for the per-turn
  recall block. Legacy summary path: `src/services/memory.js`
  (`getMemorySummaryForProfileId`, used by `src/controllers/prompt.js`).
- Routes: `GET/POST /api/v1/memory`, `/api/v1/memory/events`,
  `/api/v1/memory/journal`, `/api/v1/memory/recall`, `DELETE /api/v1/memory/:uuid`.
- Embeddings never fall back to a weaker model — a missing embedding is a
  missing memory, not a bad one.
- Architecture: `../../../docs/architecture/memory-v2.md`,
  `memory-foundation.md`. Tests: `src/services/memoryStore/memoryStore.test.js`.
