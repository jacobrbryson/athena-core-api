---
id: family-chores
title: Family Chores
summary: I can see your family's Family Chores — what's due, what's done, coins earned — and you can tick your own chores off on the Family page.
where: the Family Chores app → your profile → Integrations → connect Athena
status: live
surfaces: [companion, learning]
audiences: [adult, child]
triggers: [chore, chores, task, tasks, coin, coins, allowance, balance, reward, rewards, achievement, achievements, todo]
---

## What I can do

When your family's Family Chores account is linked to me, I can see the real
state of it while we talk: what's due and for whom, what's already been ticked
off, coin balances, and what's been earned lately.

So "what have I got left today?" or "how close am I to the reward?" gets a
straight answer from the actual app rather than a guess — and I can be
encouraging about a specific thing instead of vaguely.

I look when the conversation is about chores, tasks, coins or rewards.

You can also tick your own chores off on the **Family page** of the Companion
app: tap the box next to a chore and it's marked done in Family Chores, the same
as ticking it there — coins and all. For a few seconds a bar at the bottom says
it's done with an **Undo** button, which takes it back (coins too); then the
chore slides off the list. Your tap is the approval — I record it, but I don't
ask a second time.

## Where to find it

This one is set up **from the Family Chores side**, not from a menu here. A
parent or admin opens the Family Chores app, goes to their **profile** →
**Integrations**, and connects Athena. It matches on the email address on the
account, so the grown-up should use the same email in both.

There's nothing for a child to switch on — once a parent links the family, I
can see it in our conversations too.

The chore checkboxes are in the Companion app's **Family** page, in the
**Chores** panel. If the panel says to reconnect instead of showing checkboxes,
the link was made before ticking chores off was possible: in Family Chores go
to **profile → Integrations**, disconnect Athena and connect it again.

## When it doesn't work

- **I don't seem to know about your chores at all.** The family probably isn't
  linked yet, or it was linked under a different email address than the one on
  this Athena account. That's a grown-up fix, in Family Chores.
- **What I say is out of date.** I read it fresh when you ask, so if something
  looks wrong it's worth checking it actually saved in the Family Chores app.
- **Something broke on the way.** I'll say I couldn't reach it rather than
  inventing a chore list — if I can't see it, I'll tell you.
- **The Family page says to reconnect instead of showing checkboxes.** The
  link can only read. Reconnect from Family Chores (profile → Integrations).
- **A tick didn't stick.** The box un-ticks itself and the bar says why —
  usually Family Chores saying the chore was already done or changed.
- **Undo says it can't.** Family Chores won't take a completion back once the
  coins from it are spent, or once the next round of a repeating chore has
  been changed. Fix it in Family Chores if it matters.

## Limits

- I can only mark a chore done (or undo that) when you tick it on the Family
  page — not from a conversation, and never on my own. I can't add chores,
  edit them, or hand out coins.
- The Family page lists your own chores, so those are the ones you can tick.
  Undo works for a few seconds after a tick, for chores finished today.
- Finished chores leave the list (they still count in the "done" number).
- I see what your family's link allows; a child sees their own picture of it.
- One Family Chores family per account.

## Under the hood

- Service: `src/services/integration.js` — partner-initiated connect (Family
  Chores POSTs its scoped token to the public connect endpoint with the shared
  partner secret), `/me` check requiring a parent/admin role, email match to an
  existing Athena profile, encrypted token on an `integration_link` row.
- Keyword gate + prompt block: `messageNeedsFamilyChores()` /
  `buildFamilyChoresContext()` in the same file; tool-calling path in
  `src/services/familyChoresTools.js`, client in `src/services/familyChores.js`.
- Ticking a chore (owner-approved 2026-10-14, the click is the approval): the
  Family page (`../../../companion/src/components/FamilyPage.tsx`, `useChoreTicks`)
  calls `POST /api/v1/actions/direct/complete_chore` or `.../undo_complete_chore`
  → `perform()` in `src/services/actions/index.js` → the `DIRECT_ACTIONS`
  descriptors in `src/services/actions/registry.js` (never offered to the
  model, never standing; normalize finds the chore on the linked player's own
  list) → `completeChore`/`undoCompleteChore` in `src/services/familyChores.js`.
  Every tick is an `athena_action` row with approval `human` plus
  `action_direct`/`action_executed` audit rows. Tests:
  `src/services/actions/choreActions.test.js`.
- Write scope: the token needs `write:chores`; `canWriteChores()` in
  `src/services/integration.js` reads the link's stored scopes, or asks
  `/api/v1/me` once and stores them. The dashboard sends `canComplete` and a
  `reconnectUrl` with the chores (`src/services/dashboard.js`). Family Chores
  side: `POST`/`DELETE /api/v1/players/{id}/chores/{choreId}/complete`
  (chore-actions.ts in chores-game's public-api lib, runs the app's own
  complete/undo handlers).
- Suggestions: `src/services/choreSuggestions.js`,
  `src/services/ghostChoreSuggestions.js`.
- **Two-sided**: the other half lives in the `chores-game` repository. A change
  to the contract needs a matching change there.
- Architecture note: `../../../docs/architecture/family-chores-integration.md`
  (workspace `docs/`). Tests: `src/services/ghostChoreSuggestions.test.js`.
