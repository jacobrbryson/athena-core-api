---
id: work-items
title: Jira work runs
summary: I can prepare a Jira change plan in a configured local environment and, after approval, implement and record evidence using company keys.
where: Companion → Work → a Jira issue; Development environments & keys
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [jira task, jira sidebar, work run, work environment, dream frontend, dream backend, company key, work client, plan ticket]
---

## What I can do

On Work, I open a Jira issue in a sidebar with its description, comments,
status, assignee, subtasks and attachment names. You can choose a saved client
development environment and ask for a plan. After you confirm the planning
approval, your paired local runner checks out the configured repositories,
restores a test database, checks startup and tests, and investigates.

I keep the plan for review and notify you when it is ready. If you approve
implementation, I post that exact plan as a Jira comment, then change only the
isolated checkout. I run the configured tests and a browser walkthrough with
assertions, and provide a patch, evidence and a recording with my usual voice.
You decide whether that evidence meets the ticket's acceptance criteria.

Company OpenAI or Anthropic keys pay for ticket analysis and implementation.
Athena's core application pays for orchestration and my voice. A missing company
key stops the work; it never silently switches to a personal or core key.

## Where to find it

Open **Work → Development environments & keys**. Select the workplace, save its
company keys, pair **Work runner** on your own computer, then save a reviewed
environment revision. The initial setup uses a configuration editor: confirm the
repository branches, exact test-backup object, startup/test recipes, service URLs,
model and token ceiling. The Dream preset needs those details checked before use.

Click a Jira issue, select the environment and choose **Plan**, then confirm the
approval. The **Plan**, **Run** and **Evidence** tabs show progress, usage and
results. **Approve & implement…** opens a second approval. **Stop** cancels work.
Use **Open in Jira** for the original ticket. A browser ready notification opens
the run. The existing Android app receives the notice but may open the app's
default screen; find the run under Work.

## When it doesn't work

- Setup unavailable: the server needs its work-items migration and artifact
  storage configured. The rest of Work still works.
- No environment: pair the runner, link Jira to that workplace, save company
  credentials and a complete environment revision.
- Jira rejects a comment: check Add comments permission and write authorization.
  An ambiguous publication blocks rather than posting duplicates.
- Runner disconnected, setup failed (restore, install, build or a service not
  answering) or key unavailable: the run shows its reason. Review retained files, fix setup and start a fresh approved attempt.
- Planning approval unavailable: action approvals require the existing account
  access and action-authority consent.
- No push: check notification consent, mute and registered devices. Quiet hours
  hold the push. The ready plan stays in the app.

## Limits

This is an initial implementation and needs deployment, configuration and a
paired running computer. The first real Dream run is not yet verified.
Environments currently use PostgreSQL 17 and a Node-based runtime, exact logical
SQL, gzipped SQL or custom backups up to 20 GiB, and up to four repositories.
Package installation permits the public npm registry; private dependencies,
external application services and browser sign-in providers need further setup.
Do not put production secrets in configuration. Use sterilized test data.

Plans and environment revisions are immutable. Revision requests currently mean
stopping and creating a new run. Expired leases block instead of automatically
replaying work. Tests that already fail at baseline do not stop planning: their
output is part of the evidence. After implementation, a test that passed at
baseline and now fails blocks the run; one that already failed is reported as
still failing, never as passing. Beside PostgreSQL, an environment can ask for a
private Redis with nothing saved to disk. Its demo browser can reach repository
services at localhost ports, so an app configured for localhost talks to its own
backend. A demo can sign in through the client's test sign-in tenant (such as
Auth0) once the owner has allowed that one domain. It uses a minimal-role test
login saved encrypted in setup, which the browser types itself; I never see
it. The sandbox reaches that tenant only while the demo records. The approval
names the domain and role.

I cannot push, open PRs, merge or deploy this client code. Attachments are listed,
not downloaded. Browser demos use exact button/input labels and visible-text
assertions; unsupported criteria remain for human review. A passing test or video
does not certify the whole ticket. Tokens are recorded, but invoice exports and
automated dollar reconciliation are not included. Local volumes persist for
review and must be cleaned up explicitly with the runner instructions.

## Under the hood

- API: `../../src/routes/workItems.js`, `../../src/controllers/workItems.js`.
- Store and immutable snapshots: `../../src/services/workItems/store.js`;
  migration `../../db/migrations/0099_work_items.up.sql`.
- Scoped actions: `../../src/services/workItems/actions.js`, registered alongside
  existing descriptors without changing self-repair allowlists or standing rules.
- Jira/ADF: `../../src/services/workItems/jira.js`;
  `../../../companion/src/components/WorkItems.tsx`.
- Company models: `../../src/services/llm/adapters/workProvider.js` through guarded
  adapters; usage reservations and notifications in
  `../../src/services/workItems/engine.js`; notification backstop in
  `../../src/jobs/incidents.js`.
- Local Docker runner: `../../work-runner/runner.mjs`,
  `../../work-runner/README.md`; existing paired-device authentication.
- UI/API: `../../../companion/src/api/workItems.ts`, WorkPage/Dashboard callbacks.
- Tests: `../../src/services/workItems/workItems.test.js`,
  `../../work-runner/tests/operations.test.mjs`.
