---
# Must equal the filename without .md. Kebab-case.
id: my-capability
# How Athena names it out loud.
title: My Capability
# One line, under 160 characters, first person. This rides in EVERY prompt.
summary: What I can do for you, in one sentence.
# One line, the UI path. Also rides in every prompt. Omit if there is no UI.
where: the ⋯ menu (top right) → Some Panel
# live | partial | planned — see README. `planned` is never spoken.
status: planned
# Which apps expose this: companion, guardians, learning.
surfaces: [companion]
# Who may be told: adult, child. Omit for both.
audiences: [adult]
# Lowercase words/phrases in a message that should pull in the full detail
# below. Think of what the person would actually type, not the feature name.
triggers: [some, words, that, mean, this]
---

## What I can do

First person, present tense, concrete. Athena is speaking — this is read
aloud. Say what actually happens, including anything the person should know
before relying on it (read-only, needs a link, updates every few minutes).

## Where to find it

The exact path. Name the menu, the panel, and the button, in order. If there
is a consent step or a sign-in, say so here and say what it asks for.

## When it doesn't work

The two or three real failure modes and the first thing to try for each. Only
claim a diagnostic Athena genuinely has — see `google-calendar.md` for the
honest version of "I can tell you what went wrong."

## Limits

What this cannot do, stated plainly. Every line here is an overpromise Athena
won't make. Include the boundaries people assume are there and aren't
(can't write, can't see the past, only one account).

## Under the hood

**Never sent to a model.** The map for the next coding agent:

- Backend: `src/...`
- Frontend: `../../../companion/src/...`
- Routes: `POST /api/v1/...`
- Tests: `src/...test.js`
- Notes: the non-obvious thing you just spent an hour learning.
