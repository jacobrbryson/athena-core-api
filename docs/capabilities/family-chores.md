---
id: family-chores
title: Family Chores
summary: If your family uses the Family Chores app, I can see whose chores are due, what's done, and how many coins have been earned.
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

## Where to find it

This one is set up **from the Family Chores side**, not from a menu here. A
parent or admin opens the Family Chores app, goes to their **profile** →
**Integrations**, and connects Athena. It matches on the email address on the
account, so the grown-up should use the same email in both.

There's nothing for a child to switch on — once a parent links the family, I
can see it in our conversations too.

## When it doesn't work

- **I don't seem to know about your chores at all.** The family probably isn't
  linked yet, or it was linked under a different email address than the one on
  this Athena account. That's a grown-up fix, in Family Chores.
- **What I say is out of date.** I read it fresh when you ask, so if something
  looks wrong it's worth checking it actually saved in the Family Chores app.
- **Something broke on the way.** I'll say I couldn't reach it rather than
  inventing a chore list — if I can't see it, I'll tell you.

## Limits

- Read-only. I can't mark a chore done, add one, or hand out coins — ticking it
  off has to happen in Family Chores.
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
- Suggestions: `src/services/choreSuggestions.js`,
  `src/services/ghostChoreSuggestions.js`.
- **Two-sided**: the other half lives in the `chores-game` repository. A change
  to the contract needs a matching change there.
- Architecture note: `../../../docs/architecture/family-chores-integration.md`
  (workspace `docs/`). Tests: `src/services/ghostChoreSuggestions.test.js`.
