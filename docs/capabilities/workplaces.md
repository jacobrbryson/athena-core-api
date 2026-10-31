---
id: workplaces
title: Workplaces
summary: Where you work (workspaces on the Work page), your role and primary job, and the apps, addresses, sites and work projects that belong to each.
where: Companion → Work (the Workspaces cards at the top; the editable list under The detail)
status: live
surfaces: [companion]
audiences: [adult]
triggers: [workspace, workspaces, work page, athena's agents, workplace, workplaces, where i work, my job, my employer, my company, my role, job title, co-owner, primary job, work email, which company, whose jira]
---

## What I can do

You can tell me where you work — each company, your role there, its website
and a note about what matters — and mark one as your primary job. When you talk
about "work" without naming a company, I take it to mean your primary one, and
I ask when it matters and isn't clear.

Each workplace can also own connected apps and email addresses. Link your Jira
site to the company it belongs to and I know its tickets are that company's work;
link your work address and I know mail to or from it is that company's mail.
Its websites and work projects can belong to it too. Anything linked belongs to
one workplace only.

The **Work** page is built around them. At the top: four tiles (open Jira
issues, Slack mentions, work projects, sites monitored), then a card per
workspace with its role, website, linked apps and its counts of issues,
projects and sites. Below that: your Jira issues (all, in progress, in review),
Slack mentions, **Athena's Agents** — the code investigations and fixes you
approved this week and their state, your company PR reviews as they run, plus
the site monitor — your work projects
(active, on hold, completed) with their progress, each site's uptime and
response time, your work meetings in the next 7 days, a blend of recent
activity, and quick actions. A Jira issue counts toward a workspace only when
its Jira site is linked there.

**Click a workspace card to open that workspace's own dashboard.** Below its globe
header is the shared tablist for Overview, Jira, GitHub, Deployments, Monitoring,
Team and Docs, followed by three shared metric cards (My Tasks, Pull Requests
and Deployments), styled like Family and Property.
Overview shows recent activity, **Pull Requests**
(**Open PRs**), workspace email, recent deployments, key services and quick
actions. Activity can be filtered by source; pull requests by open, reviewing
or draft; email by all new, other mail or receipts. Jira shows its issues;
Monitoring includes linked sites; Team has Slack mentions, upcoming work events
and my agents; Docs currently shows Jira epics. Workspace email matches new
mail from its website's domain or your linked work addresses.
Pull requests come from the GitHub key linked to that workspace and are
grouped by repository — `helpful_db_scripts`, `Dream-Backend` and
`Dream_frontned` first, then everything else. Projects are that workspace's open
Jira epics for now, with how many of their issues are done.

Repository headings now open a **Review Criteria** drawer. Pull request rows
open a details drawer with description, discussion, reviewers and **Let Athena
Review**. The pencil button beside the workspace name (tooltip: **Edit workspace**) opens a shared settings drawer:
name, role, website, primary-job flag, notes, company credentials and the review
model, linked apps and email addresses, sites and work projects. Changes to
workspace details update the header after saving. Reviews are editable drafts until you choose a
GitHub review decision and confirm that exact submission; see **Company pull
request reviews** for the full workflow and limits.

I only know what you type and link here. I suggest a link when a connected app
signed in with an address at a workplace's website — "Jira Cloud ·
rbryson@vivacitytech.com looks like Vivacity Tech PBC's" — but I never link one
myself.

## Where to find it

Open **Work**. **Add workspace** on the Workspaces card scrolls to the
editable **Workspaces** panel under **The detail**. **Add a
workplace** there opens a short form: company, your role, website, **My primary
job**, and notes for me. The first one you add is your primary until you
choose another.

Inside an individual workspace dashboard, the pencil beside its name opens
**Edit workspace**. The website link stays below the name. Use **Save** for
the workspace details, the encrypted key controls for company credentials,
**Save review provider** for the model, and the link controls or checkboxes for
apps, email addresses, sites and projects. These changes use the same ownership
rules as the Work page's existing editor.

Under each workplace, its connected apps and email addresses show as small
chips. An app chip is green with a ✓ when I can read it, and red with an ✕ when
I can't — it needs reconnecting, it was removed, or my last read of it failed
(a Jira API token Jira now rejects shows here). Tap a chip to see why. A dashed
**＋ Jira** chip is a suggested link; tap it to link it.

Everything else is in the workplace's **⋯** menu: **Edit**, **Link email or
app**, **Make primary**, **Unlink** for each app and address, and **Remove
workplace**. Removing a workplace unlinks its apps and addresses; it doesn't
disconnect anything.

On a workspace card, **⋮** (or its counts) opens **Manage**: tick the sites and
work projects that are that workspace's. One already belonging to another
workspace is greyed out with that workspace's name.

## When it doesn't work

- **The panel says your workplaces are unavailable.** It's a temporary problem
  on my side; reload the page. Nothing you saved is lost.
- **"You already have that on your list."** Two workplaces can't share a name —
  edit the existing one instead.
- **A website won't save.** Use just the domain, like example.com.
- **"That already belongs to …"** An app, address, site or project can belong
  to one workplace. Unlink it there first.
- **Manage says sites and projects can't be given to a workspace yet.** The
  database update that adds this hasn't been applied; the rest of the page
  works without it.
- **A workspace shows 0 issues.** Issues count toward it only when its Jira
  site is linked to it — link the Jira connection under that workspace.
- **An app I want isn't in the list.** Only connected apps that no workplace owns
  yet are listed; connect it first under ⋯ menu → Connected apps. Health apps
  like WHOOP never belong to a workplace.
- **An app chip is red.** Tap it for the reason. Reconnect it under ⋯ menu →
  Connected apps; the link stays and turns green when the same account is
  reconnected and read again. If the reason is a failed read, it may clear on
  its own at the next dashboard load.

## Limits

- Business totals in the Vivacity header (5,321 customers, 2.9M devices, 1.6M
  Google Synced and 248K repair tickets), deployment data,
  service health and the operational banner are labeled design previews until
  their live feeds are connected. I cannot use them as evidence of current
  business activity or system health.
- A workspace dashboard's pull requests are every open one in the GitHub
  organizations that workspace's key belongs to, plus any elsewhere that involve
  you or wait on your review (up to 100 per search), read
  with that workspace's own GitHub key only (never another workspace's), and
  its epics need that workspace's Jira linked with an API token. A card whose
  key isn't linked says so instead of guessing.
- Its email card matches mail by the sender's domain, so mail from outside the
  company to your work address isn't picked up there.

- Up to 20 workplaces; one primary.
- Slack shows mentions only — not threads or DMs.
- The agents panel shows the code investigations and fixes you approved in the
  last week and this week's company PR reviews; there are no other background
  agents to show yet.
- Linking says what a connection is for; it doesn't change which account I use.
  General chat still cannot switch between a company's own accounts or keys.
  The dedicated Work runs workflow can use an explicitly selected company
  OpenAI/Anthropic key and GitHub read token; configure those under Work →
  Development environments & keys.
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
- Workspace dashboard: `GET /api/v1/dashboard/workplaces/:uuid/dashboard`
  (`src/controllers/workplaces.js` → `src/services/workspaceDashboard.js`) returns
  `{ pullRequests, epics }`, each `{ items, error }` (`not_connected`,
  `unsupported`, `rejected`, `unavailable`). Read-only; it takes the
  workspace's own linked `github`/`jira` credential via `credentials.get` and
  never falls back. Frontend: `../../../companion/src/components/WorkspacePage.tsx`,
  route `/work/:uuid`. Tests: `src/services/workspaceDashboard.test.js`.
- Tests: `src/services/workplaces.test.js`.
- Next (owner, 2026-10-13): per-workplace credentials — Jira, GitHub, OpenAI
  and Claude keys for Vivacity Tech PBC, Orcwood's as the default. Those go in
  `user_credential` (encrypted, 0024), tied to a workplace through
  `athena_workplace_link`, never in `athena_workplace`; touching credentials and connector paths is protected
  and needs the owner's explicit go-ahead in that change.
