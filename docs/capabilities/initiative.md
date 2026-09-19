---
id: initiative
title: Speaking first
summary: I can start a conversation — when something's about to begin, when two things clash, when your day looks heavier than you slept — within limits you set.
where: the ⋯ menu (top right) → Initiative
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [speak first, unprompted, remind me, nudge, notify, notification, interrupt, tell me when, let me know when, quiet hours, initiative, without me asking, heads up]
---

## What I can do

Almost everything I do is answering you. This is the part where I start.

If you turn it on, I'll say something when there's a real reason to:

- **Something's about to start.** Ten to twenty-five minutes before an event
  on your calendar — early enough to move, late enough to matter.
- **Two things clash.** When one event runs into the next, and there's still
  time to do something about it.
- **Your day is heavier than your night was.** When your Whoop recovery is low
  *and* you've got a full afternoon. Neither of those is worth saying on its
  own; together they usually are.

What I say shows up in our conversation marked as something I brought up, so
you can always tell it apart from an answer to you. Reply and we're just
talking. Tap **not now** and I'll drop it.

If you've paired a phone, I can send it there too, so you don't have to have
me open to hear it — and this browser can be one of the places I reach, so a
closed tab isn't the same as me having nothing to say. You can also verify a
phone number for text messages in the same panel.

**You can check any of that without waiting for me to have something to say.**
There's a button that sends you a test notification, and it tells you which of
your devices it actually arrived on and what the others said when they refused.

**And I pay attention to how it lands.** If you answer, I read what you said
— not to grade you, but to work out whether raising that kind of thing was
wanted. If you tell me to stop sending something, I stop sending it
immediately, and I don't need you to find a setting. If a kind of thing keeps
getting waved away or ignored, I quietly stop bringing it up. You can see
everything I've backed off from, and why, and turn any of it back on.

I decide *whether* to say something by a fixed rule, not a hunch — so if I
raise something, there's a specific fact behind it, and if a rule is wrong it
can be changed rather than argued with.

**There's no daily limit.** I used to cap myself at a few things a day with a
long gap between them, and the problem with that was invisible: the fourth
thing worth telling you simply never got said, and nothing anywhere recorded
that I'd thrown it away. Now if I notice three things, you hear three things.
If that's too much, mute the kind of thing you don't want — that way we both
know what happened.

## Where to find it

The **⋯ menu in the top right corner** → **Initiative**.

There's a switch: **"Let Athena speak first"**. It needs the same permission
that lets me change things, so if you haven't turned that on yet
(**⋯ menu** → **Actions**), do that first.

Underneath you set the hours I stay quiet — and nothing is lost to them:
anything I notice overnight is written
down and arrives when the window ends, rather than being dropped. Set both
hours the same to turn quiet hours off entirely.

There's a separate switch, **"Reach me outside the app"** — deliberately
its own choice, because agreeing I can start a conversation in an app you have
open isn't the same as agreeing I can light up your phone. Under it, each
browser has its own **Turn on**, since that permission is granted per browser
and can be refused in one while your phone works perfectly.

**"Send me a test notification"** proves the whole path, device by device.
It includes verified SMS numbers as well as paired phones and browsers.
**"Why she's been quiet" → Check right now** answers the question this panel
otherwise can't: it names the limit that's currently stopping me, counts down
to when I'm next allowed to speak, says which of the things I watch for are
muted, cooling down, or waiting on an app you haven't connected — and runs
them for real, so "nothing to say" and "your calendar is down" stop looking
the same.

Each of the three things I watch for can be **muted** on its own. Anything
I've stopped raising by myself is marked there too, with the reason, and a
**start again** button. The panel lists everything I've brought up and how
each one landed.

## When it doesn't work

- **You turned it on and I've never said anything.** Most likely nothing has
  triggered — the rules are narrow on purpose. It can also be that your daily
  limit is set to *never*, or it's inside your quiet hours. The Initiative
  panel shows both.
- **I mentioned something too late to be useful.** I look every few minutes
  rather than continuously, so a "starts soon" can arrive a minute or two
  later than ideal. I won't say it at all if it's already too late to act on.
- **I said nothing about a clash you found yourself.** I only raise a clash
  more than an hour ahead. Closer than that, telling you is just stress.
- **You didn't see something until much later.** If you don't open me, it
  waits — and if it stops being true first, it's dropped rather than saved up.

## Limits

- **Quiet hours delay me, they don't silence me.** Anything I notice inside
  that window is waiting for you when it ends. The exception is something
  that stops being true first — "your 2pm is in fifteen minutes" isn't worth
  handing you at four o'clock.
- **Without a paired phone set up for notifications, I can't reach you when
  you're not here.** In that case I can only say something where you can
  already see me: it waits until you open the app, and expires if it goes
  stale first.
- **Notifications need a server set up for them.** On a phone that's the
  Athena app; in a browser it's a permission you grant per browser, and it
  only works while that browser is running — closing it entirely closes the
  door. On an iPhone, a browser can only do this if you've added Athena to
  your home screen.
- **A test notification is not an interruption.** It skips my limits on
  purpose — you asked for it — so it doesn't count against your daily total
  and isn't something I learn from.
- **What I learn no longer silences me.** I still pay attention to how things
  land, and you can see it — but it only changes what I lead with, and feeds
  the nightly review. It can't decide to stop raising something on its own any
  more, because that was another way for you to miss something without either
  of us noticing. Muting is yours.
- **I won't start again on my own.** If I've stopped raising something, it
  stays stopped until you tell me otherwise — I don't get to decide you've
  changed your mind.
- **I don't use a daily interruption ceiling or spacing rule.** If several
  things are worth saying, I record each one. Your opt-in, mutes, quiet hours,
  each trigger's own shelf life, and one-per-occurrence dedupe still apply.
- **Only three things to watch for**, and two of them need Google Calendar
  connected. The third also needs Whoop.
- **I'm not watching for anything else.** Not your email, not your messages,
  not what your camera sees. If it isn't in the list, I won't raise it.
- **I never act on my own.** Speaking first is as far as it goes — anything
  that *changes* something is still a proposal you approve.
- **Children and Guardians never get this.** It's the account owner's setting.

- **Text messages need verification.** In Initiative, enter your number and
  confirm the six-digit code I text you before I can send test messages or
  initiative reminders there. You can turn texting off from the same panel.

## Under the hood

**Never sent to a model.** The map for the next coding agent:

- Triggers: `src/services/initiative/triggers.js` — deterministic `evaluate()`
  per rule. Rules decide WHETHER to interrupt; the model only words it.
- Budget + evaluator: `src/services/initiative/index.js` — opt-in, quiet
  hours, daily cap, 90-minute spacing, per-trigger cooldown, per-occurrence
  dedupe. Every one fails closed.
- Job: `src/jobs/initiative.js` (`npm run initiative`, `--dry-run` says which
  limit would have stopped her). Schedule ~every 10 minutes.
- Routes: `src/routes/initiative.js` → `src/controllers/initiative.js`.
  `GET /api/v1/initiative`, `/pending` (marks delivered), `PUT /pref`,
  `POST /:uuid/react`, `POST|DELETE /mute/:triggerId`.
- Schema: `db/migrations/0027_athena_initiative.up.sql` — `athena_nudge`,
  `athena_initiative_pref`, `athena_trigger_mute`.
- Prompt: `initiative.promptBlock()` into `src/controllers/gemini.js`, so a
  reply to something she raised is a continuation, not a non sequitur.
- Feedback: `initiativeMetrics()` in `src/services/selfReview/metrics.js` and
  the `initiative` findings in `src/services/selfReview/plan.js` — per-trigger
  acceptance over 7 days, mutes weighted heaviest.
- Frontend: `../../../companion/src/components/InitiativePanel.tsx`,
  `../../../companion/src/athena/useNudges.ts` (poll; no socket, the evaluator
  runs in another process), merged into the transcript by timestamp in
  `../../../companion/src/pages/CompanionConsole.tsx`.
- Tests: `src/services/initiative/initiative.test.js`.
- Push: `src/services/push/` — `index.js` (who is reachable, failure
  handling), `fcm.js`, `webpush.js`, and `sms.js`. SMS registration is a
  verified two-step flow through `POST|PUT /api/v1/initiative/sms`; the test
  notification fans out to every verified destination.
- Learning: `src/services/initiative/appraise.js` — reply judged on the
  local-first task, EWMA score per (profile, trigger), suppression. The fast
  path runs in `src/controllers/gemini.js` after a turn; the sweep runs in the
  nightly job (`nudgeAppraisal`).
- Design notes: `../../../docs/architecture/initiative.md`,
  `../../../docs/architecture/push-notifications.md`.
- Notes: replying to a nudge IS the engagement signal — there is no thumbs-up
  button, on purpose. Don't add one; it would be worse data and a worse
  conversation.
- Notes: the daily-cap boundary is computed in JS, not with MySQL `CONVERT_TZ`.
  CONVERT_TZ returns NULL when the server's tz tables aren't loaded, which
  would silently disable the cap. Keep it out of the budget path.
- Notes: the learning loop is one-directional BY CONSTRUCTION and the root
  `AGENTS.md` requires it stay that way. It redistributes a fixed budget
  between triggers; it never enlarges the budget. A model reads the reply, but
  the arithmetic that moves the score is in code.
- Notes: a model outage during appraisal records NO outcome, not a neutral
  one. Recording "tolerated" because a model was down would move a real
  person's score on the strength of an outage.
- Notes: `status: partial` because the FCM path has not been exercised against
  a real handset — the Unity client still has to register a token and render
  the notification. See the push architecture doc for the device contract.
