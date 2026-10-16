---
id: actions
title: Doing things, not just saying them
summary: I can offer to do something real — add an event, save a fact, look through your camera — and you approve it before anything happens.
where: the ⋯ menu (top right) → Actions
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [investigate, look into the code, fix it, fix that, fix the bug, your code, own code, change your, update your, your dashboard, padding, margin, spacing, layout, chatgpt, pull request, merge, deploy the fix, claude code, codex, why is it broken, debug, find the bug, add to my calendar, put it on my calendar, book, schedule it, schedule that, make an event, create an event, can you do it, do it for me, remember that, actions, approve, without asking]
---

## What I can do

Most of what I do is read and answer. This is the part where I can change
something — but never on my own.

When you ask me to put something on your calendar, I don't do it. I propose it:
a card appears under my reply saying exactly what I'm about to do, and nothing
happens until you tap **Approve**. If you tap **No**, or leave it, nothing
happens at all. I genuinely cannot skip that step — it isn't restraint on my
part, it's how I'm built.

The card stays in the conversation where I proposed it. While it's the last
thing in the chat it's open; once we've talked on, it folds to a single line.
A small counter in the message box (like "2 ↑") shows how many unanswered cards
have folded — tap it to scroll up and open the next one, and keep tapping to
move through them. Nothing is approved by a folded card; you open it first.

Two things I can propose today:

- **Add a calendar event** to your own Google Calendar.
- **Take a look through your camera**, when seeing would answer what we're
  talking about. See [camera.md](camera.md) — this is the one action I can do
  repeatedly on my own once you allow it, and the only one that opens something
  on your device.
- **Change a thermostat** — on your Google Nest thermostats: switch the mode
  (heat, cool, heat-cool, off), set the temperature, or turn eco on or off.
  One thermostat per card, and I ask every time, because the whole house
  lives with it. Heat stays between 50 °F and 80 °F and cooling between
  62 °F and 88 °F. I won't try one that's offline or not reporting. See
  [nest.md](nest.md).
- **Save a fact** to my long-term memory, when you ask me to remember
  something specific.
- **Log a family health update** — start a health watch ("Thomas has a
  fever"), log a reading or a dose on one, change how often I ask, or end it
  when they're better. See [family-health.md](family-health.md).
- **Set a place reminder** — "next time I'm at Missy's, remind me to…". See
  [place-reminders.md](place-reminders.md); the card shows the address I'll
  watch for, so you can catch the wrong place before it's set.
- **Have Claude Code and Codex investigate a bug** in my own apps — "your
  dashboard is pulling bad data for Jira". They read the code and explain the
  likely cause; they can't change anything. Their findings take a few minutes,
  and I'll tell you what they found when they're back, or when you ask. Only
  for the owner's account.
- **Have a coding agent change my code** — fix a bug, usually right after an
  investigation, or make a small change you ask for, like tightening the
  spacing on a dashboard card. Yes, this means changing my own code: you
  authorized it, and anything touching security or sign-in is refused by a
  check automatically. Claude Code writes it (or Codex — "ChatGPT" — if you'd
  rather) and opens a pull request, which merges and deploys by itself only if
  every check passes. I
  always ask first for this one, every time, and I'll tell you when it's
  merged, or if a check stopped it. Only for the owner's account.

**When there's more than one way to do it, I ask first.** "I can put an
alert on your calendar for 7, or remind you when you pull into the driveway —
which?" You pick, and change anything you like ("the calendar, but make it
2:00"), and only then does a card appear.

Completed, declined and expired cards stay in chat when you return. Tap
**Reply in thread** beneath my message to discuss that request; reminder and
coding updates return to the same thread. See [chat-threads.md](chat-threads.md).

**You can change a card that's still waiting.** Tell me what's wrong with it
and I'll propose a corrected one. The old card stays in history as declined
and no longer has an approval button.

**If what I tried doesn't work, I don't just stop.** When something I propose
is turned down before it reaches you — I'm missing an address, say, or the
time didn't make sense — I see why, and either fix it, offer the nearest
thing I can do, or ask you the one question I need answered.

**I don't do the same thing twice.** If you ask again for something I've
already done in the last few hours — the same event at the same time, the
same investigation, the same reminder — I tell you it's already done instead
of doing it again. With a standing "yes", saying "yes please" after I've
already added it won't add a second one. A card that failed, expired or that
you said no to doesn't count, so asking again after one of those always works.

If you get tired of approving the same thing, you can tell me to stop asking:
tick **"Do this without asking me each time"** and I'll just do that one kind
of thing from then on. I still record every single one, and you can take that
permission back whenever you like.

You can see everything I've done, and everything I asked and you said no to,
in the same panel.

## Where to find it

The **⋯ menu in the top right corner** → **Actions**.

The first time, there's a switch to turn on: **"Let Athena propose changes"**.
Until you accept that, I stay read-only — I won't even offer.

Adding calendar events also needs Google Calendar connected (**⋯ menu** →
**Connected apps**), and it needs the *newer* connection. If you linked your
calendar before this feature existed, I can read it but not write to it; the
Actions panel will say so, and reconnecting it from **Connected apps** fixes
it.

Approval cards work on your paired phone or car too, not just in this browser.

## When it doesn't work

- **The card says "Expired".** Proposals only stay valid about fifteen
  minutes, on purpose — I don't want a card from this morning quietly adding
  something this evening. Just ask me again.
- **"I can read this calendar but not write to it yet."** Your Google
  connection predates this feature. Go to **⋯ menu** → **Connected apps** and
  reconnect Google Calendar; it will ask for one extra permission.
- **Approve did nothing and the card went red.** The error on the card is the
  real reason from Google, not my guess at it. Nothing was changed.
- **I said "I couldn't set that up" and named something missing.** I tried
  twice and was turned down both times. Tell me the missing piece (usually an
  address or an exact time) and I'll try again.
- **There are two cards for the same thing.** I should have replaced the
  first one. Tap **No** on the one you don't want; it changes nothing.
- **I said I'd already done it, but you really do want a second one.** I
  treat the same request within a few hours as a repeat. Change something
  about it (the time, or what it's called) and I'll do it.

## Limits

- **I always ask first**, unless you explicitly ticked the box for that one
  kind of action. There is no way for me to act without either your tap or
  that box.
- **I can only add to your own primary calendar.** Not a shared household
  calendar, not someone else's.
- **I can't invite anyone to an event.** Adding guests would email them, and
  nobody approved that but you — add guests yourself afterwards.
- **I can't move, edit or cancel an existing event.** Only add a new one.
- **I can't schedule more than a year out**, or anything in the past, or a
  single event longer than two weeks.
- **One proposal per reply.** I won't queue up a batch of changes.
- **I never merge or deploy code myself.** A fix merges only through GitHub's
  auto-merge, after every required check passes, and Cloud Build deploys it.
  Anything touching security, sign-in, permissions, my actions, dependencies or
  deployment is refused by a check before it can merge — the owner changes
  those by hand.
- **A fix can't be undone with a tap.** Once merged it's live; reversing it
  is another fix. That's why I ask every time and never take a standing "yes"
  for it.
- **Coding agents only work in my four app repositories**, and every
  investigation or fix opens an issue on GitHub there.
- **Children and Guardians can't approve anything**, and I won't offer them
  actions at all. This is the account owner's decision.
- **A look can't be undone.** Adding an event or saving a fact are things you
  can reverse yourself; a look has already happened by the time you read about
  it, which is why its card says so and why allowing me to take them on my own
  is a separate decision.
- **I can't undo an action for you.** The other two are things you
  can undo yourself — delete the event, delete the memory — and the card says
  so before you approve.

## Under the hood

**Never sent to a model.** The map for the next coding agent:

- Executor: `src/services/actions/index.js` — propose / confirm / decline,
  standing approvals, expiry. The only path to a provider call.
- Registry: `src/services/actions/registry.js` — one descriptor per action.
  `normalize()` is the untrusted-input boundary; adding an action should touch
  nothing else.
- Writes: `src/services/connectors/googleCalendar.js` (`createEvent`,
  `deleteEvent`) and `src/services/memory.js` (`upsertMemoryForProfile`).
- Model surface: `proposed_action` in `RESPONSE_SCHEMA`
  (`src/controllers/prompt.js`), prompt block from `actions.promptBlock()`,
  proposal created in `src/controllers/gemini.js`.
- Routes: `src/routes/actions.js` → `src/controllers/actions.js`.
  `GET /api/v1/actions`, `/pending`, `/history`,
  `POST /api/v1/actions/:uuid/confirm|decline`,
  `POST|DELETE /api/v1/actions/authority/:actionId`.
- Schema: `db/migrations/0026_athena_action.up.sql` — `athena_action`,
  `athena_action_authority`.
- Frontend: `../../../companion/src/components/ActionProposal.tsx` (card),
  `../../../companion/src/components/ActionsPanel.tsx` (panel),
  `../../../companion/src/athena/useActions.ts` (socket + poll).
- Expiry job: `src/jobs/nightly.js` (`actionExpiry` step).
- Coding agents: `investigate_code` in the registry, `src/services/codeAgents.js`
  (repo allowlist, GitHub issue, findings read back into chat), workflow
  `.github/workflows/athena-investigate.yml` in each repo (read-only token,
  comments marked `<!-- athena-agent:claude|codex -->`). Needs
  `GITHUB_AGENT_TOKEN` and `CODE_AGENT_GOOGLE_IDS` in Secret Manager; offered
  only via the registry's `availableTo` hook. Tests:
  `src/services/codeAgents.test.js`.
- Code fixes (owner-authorized 2026-10-10, workspace AGENTS.md "Code
  fixes"): `fix_code` in the registry (`standing: false`, never grantable),
  `openFix` / `fixStatus` in `src/services/codeAgents.js` (issue labeled
  `athena-fix`, plus `athena-fix-codex` for Codex; status read from the
  `<!-- athena-fix-pr: … -->` / `athena-fix-result` comments and the PR's
  merged state). Workflow `.github/workflows/athena-fix.yml`: an `edit` job
  (agent, read-only checkout, no shell, emits a patch) and a `publish` job in
  the `athena-publish` environment (GitHub App token minted for one repo, push
  `athena/fix-<n>-<agent>`, PR, auto-merge). Required checks: `ci` and
  `protected-paths` (`.github/workflows/protected-paths.yml`). Secrets:
  `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` via the `github-fix` pool and
  service account `athena-gh-fixer`.
- No dead ends (2026-10-10): `actions.attempt()` returns `{ proposal,
  rejected: { stage, reason } }`; `propose()` is a wrapper that keeps the old
  contract. `gemini.js` gives one repair pass (`actionRepairNote`) and then
  `couldntSetUp()`. Descriptors may carry `alternatives` (a model hint, never
  a gate). Pending cards reach the prompt via `actions.pendingBlock()`;
  `proposed_action.supersedes` withdraws the old card (as a decline, audit
  `action_superseded`) only after the new row exists. Rejections are logged
  to `athena_capability_gap` (`src/services/capabilityGaps.js`, migration
  0058) and summarized for the nightly review (`src/services/selfReview/metrics.js`
  `gaps`). The inner monologue now reads action drafts but can only turn them
  into a question. Tests: `src/controllers/actionRepair.test.js`.
- Repeats (2026-10-11, after a calendar event and a GitHub issue were each
  created twice): `earlierCopy()` in `index.js` runs after `normalize()` and
  before the insert; a pending/executing/done row of the same action within
  `REPEAT_WINDOW_HOURS` that the descriptor's `sameAs(earlier, params)` (or
  identical params) matches returns `{ repeat }` and writes nothing. Calendar
  matches on times + loose title (location ignored); investigate/fix on repo
  + loose text; `look_through_camera` opts out. The prompt also gets
  `recentBlock()` (done in the window) and a standing-approval note per action
  so she stops asking "want me to?" for things that run on proposal.
- Tests: `src/services/actions/actions.test.js`.
- Design notes: `../../../docs/architecture/action-layer.md`.
- Notes: the chat path uses structured output, not function calling, which is
  *why* the propose/confirm gate is structural rather than a policy — Athena
  has no mechanism to invoke anything. Keep it that way. If a future action
  needs a tool-calling loop, the loop must still terminate in an
  `athena_action` row rather than a live call.
- Notes: `status: partial` because the Google write path has not been
  exercised against the live API, and existing calendar links need a re-consent
  for the `calendar.events` scope. Flip to `live` once both are settled.
