---
id: brain
title: My brain (model router)
summary: You can see which models are answering you right now, how much is being served locally, and how I'm routing around unhealthy ones.
where: the ⋯ menu (top right) → Brain, or the pill in the top bar
status: live
surfaces: [companion]
audiences: [adult]
triggers: [brain, model, models, router, routing, local model, llm, which model, gpu, offline, slow, latency, double-check, double check, almost said, monologue, first draft, second thought, did you check]
---

## What I can do

I run on more than one model, and I'd rather you could see that than have it be
a black box.

The Brain panel shows what's serving each kind of work right now — chat,
vision, memory — whether that's local or a frontier provider, the active
routing policy, and what share of my recent answers were served locally.

I watch my own speed, errors and output validity. When a model starts
misbehaving I prefer an alternative in the same tier, and I rest the unhealthy
one and retry it later — observations expire, so something that recovers gets
another chance rather than being written off.

I also take a second look before I answer. When a reply I've drafted states
facts — a score, a price, opening hours, a date — a different model checks
whether I actually had grounds for each one. If something was a guess, I look
it up and rewrite the reply, or I rewrite it to say I'm not sure. You might
hear "hm, let me double-check that" while I do. The Brain panel's **What I
almost said** section shows those second looks: what I drafted, what was
wrong with it, what I searched and what I sent instead.

## Where to find it

The **⋯ menu in the top right corner** → **Brain**, or tap the small brain pill
in the top bar next to the menu. It's read-only — a window into how I'm
working, not a control panel.

## When it doesn't work

- **A tier shows as offline.** The local server is unreachable or resting.
  Everything still gets answered; it just routes elsewhere.
- **I'm answering slowly.** The panel says which tier is serving and what
  share is local — a sudden drop in local share usually means the local server
  is down, which is a real thing to go and check.
- **What I almost said is empty.** It only keeps recent conversations, and it
  starts over whenever I'm updated. It also only shows replies I stopped to
  check — most replies have no facts to check and go straight out.
- **A reply came back broken.** If a model's output fails validation I skip to
  the next tier rather than hand you nonsense. Persistent failures show up in
  the panel's performance section, and the nightly self-review records them for
  the owner.

## Limits

- Read-only. You can't pin a model or change the policy from here.
- It shows recent activity, not long-term history.
- Routing is mine to decide — this panel explains it, it doesn't negotiate it.
- My second look checks facts, not tone, and it can still miss things. It
  isn't a guarantee — if something matters, ask me where I got it.
- What I almost said lasts until my next update, and only covers your own
  conversations. Children's conversations don't get the second look.

## Under the hood

- Panel: `../../../companion/src/components/BrainStatus.tsx`. Routes:
  `GET /api/v1/llm/status`, `GET /api/v1/llm/manifest`.
- Router: `src/services/llm/router.js` (local-first, frontier-last policy),
  health in `health.js`, automatic preference in `autotune.js`, per-call
  telemetry in `telemetry.js` (`llm_call_log`).
- Embeddings deliberately never fall back to a weaker model.
- Inner monologue: `src/services/monologue.js` (Jev screen → critique task
  with `avoid` = the drafter → web search and/or rewrite; in-memory record,
  25 turns per person), wired in `src/controllers/gemini.js` (`writeReply`,
  `DOUBLE_CHECK_FILLER`), route `GET /api/v1/llm/monologue`
  (`src/controllers/companion.js` `llmMonologue`), tests
  `src/services/monologue.test.js` and `src/controllers/webGrounding.test.js`.
  `GEMINI_CRITIQUE_MODEL` / `OPENAI_CRITIQUE_MODEL` pick the critic; in
  production only Gemini is configured, so the critic is the same model in a
  reviewing role until another is set.
- Every provider call goes through the guarded adapters and a live access
  check — see `AGENTS.md`. Nothing about routing may be changed by a
  self-improvement run.
- Nightly review: `src/services/selfReview/`, reports land in the
  `self_review_report` table (not on disk).
- Architecture: `../../../docs/architecture/model-router.md`,
  `automatic-local-management.md`. Tests: `src/services/llm/router.test.js`,
  `telemetry.test.js`.
