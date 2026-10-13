---
id: workplaces
title: Workplaces
summary: I keep a list of where you work, your role at each and which is your primary job, and which connected apps and email addresses belong to each.
where: Companion → Work → Workplaces
status: live
surfaces: [companion]
audiences: [adult]
triggers: [workplace, workplaces, where i work, my job, my employer, my company, my role, job title, co-owner, primary job, work email, which company, whose jira]
---

## What I can do

You can tell me where you work — each company, your role there, its website
and a note about what matters — and mark one as your primary job. When you talk
about "work" without naming a company, I take it to mean your primary one, and
I ask when it matters and isn't clear.

Each workplace can also own connected apps and email addresses. Link your Jira
site to the company it belongs to and I know its tickets are that company's work;
link your work address and I know mail to or from it is that company's mail. A
connection or address belongs to one workplace only.

I only know what you type and link here. I suggest a link when a connected app
signed in with an address at a workplace's website — "Jira Cloud ·
rbryson@vivacitytech.com looks like Vivacity Tech PBC's" — but I never link one
myself.

## Where to find it

Open **Work** and look for the **Workplaces** panel at the top. **Add a
workplace** opens a short form: company, your role, website, **My primary
job**, and notes for me. The first one you add is your primary until you
choose another.

Under each workplace, its connected apps and email addresses show as small
chips. An app chip is green with a ✓ when I can read it, and red with an ✕ when
I can't — it needs reconnecting, it was removed, or my last read of it failed
(a Jira API token Jira now rejects shows here). Tap a chip to see why. A dashed
**＋ Jira** chip is a suggested link; tap it to link it.

Everything else is in the workplace's **⋯** menu: **Edit**, **Link email or
app**, **Make primary**, **Unlink** for each app and address, and **Remove
workplace**. Removing a workplace unlinks its apps and addresses; it doesn't
disconnect anything.

## When it doesn't work

- **The panel says your workplaces are unavailable.** It's a temporary problem
  on my side; reload the page. Nothing you saved is lost.
- **"You already have that on your list."** Two workplaces can't share a name —
  edit the existing one instead.
- **A website won't save.** Use just the domain, like example.com.
- **"That already belongs to …"** An app or address can belong to one workplace.
  Unlink it there first.
- **An app I want isn't in the list.** Only connected apps that no workplace owns
  yet are listed; connect it first under ⋯ menu → Connected apps. Health apps
  like WHOOP never belong to a workplace.
- **An app chip is red.** Tap it for the reason. Reconnect it under ⋯ menu →
  Connected apps; the link stays and turns green when the same account is
  reconnected and read again. If the reason is a failed read, it may clear on
  its own at the next dashboard load.

## Limits

- Up to 20 workplaces; one primary.
- Linking says what a connection is for; it doesn't change which account I use.
  I can't yet switch between a company's own accounts or keys when you're
  working on that company's things.
- An email address you link is a label, not a mailbox: I read only the Gmail
  you've connected, so a work address helps only for mail that reaches it.

## Under the hood

- Service: `src/services/workplaces.js` — CRUD, single-primary rule (marking
  one clears the rest; the first added is primary; removing the primary
  promotes nothing), `link`/`unlink`, `overview` (unlinked connections with a
  domain-match suggestion), `promptBlock` on every adult turn that has any.
  Reads `user_credential` metadata only (uuid, provider, external account,
  display name, status) — never a token column; a test pins that. `LINKABLE`
  is the provider allowlist.
- Controller/routes: `src/controllers/workplaces.js`;
  `GET|POST /api/v1/dashboard/workplaces`, `PATCH|DELETE …/:uuid`,
  `POST …/:uuid/links` (`{credential}` or `{email}`), `DELETE …/:uuid/links/:linkUuid`.
  Every response is the whole `{ workplaces, available }` overview.
- Chat context: wired in `src/controllers/gemini.js` beside the websites block.
- Migrations: `../../db/migrations/0064_workplace.up.sql` (`athena_workplace`),
  `../../db/migrations/0065_workplace_link.up.sql` (`athena_workplace_link`;
  exclusivity is the unique keys on `(profile_id, credential_uuid)` and
  `(profile_id, email)`).
- Chip health (`readable` in the component): red when the credential is
  `needs_reauth`/revoked/removed, or when the dashboard summary's latest read
  of that source (`jira`, `slack`, `emailTriage` for gmail, `calendar`) isn't
  `ready`. The summary half is what catches the Jira API-token path
  (`src/services/connectors/jiraApiToken.js`), which throws on a 401/403
  without flagging the credential. Sources the summary doesn't read (contacts,
  websites) are judged by credential status alone.
- Frontend: `../../../companion/src/components/Workplaces.tsx` (actions in the
  shared `OptionsMenu` from `FamilyPeople.tsx`), mounted on
  `WorkPage` in `../../../companion/src/components/Dashboard.tsx`; mock in
  `../../../companion/mock/client.ts`.
- Tests: `src/services/workplaces.test.js`.
- Next (owner, 2026-10-13): per-workplace credentials — Jira, GitHub, OpenAI
  and Claude keys for Vivacity Tech PBC, Orcwood's as the default. Those go in
  `user_credential` (encrypted, 0024), tied to a workplace through
  `athena_workplace_link`, never in `athena_workplace`; touching credentials and connector paths is protected
  and needs the owner's explicit go-ahead in that change.
