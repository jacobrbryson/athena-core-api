---
id: workspace-reviews
title: Company pull request reviews
summary: I can draft a company-funded PR review using saved repository criteria, then submit your edited text and decision after your confirmation.
where: Companion → Work → a workspace → Pull Requests; the pencil beside the workspace name manages company keys and the review provider.
status: live
surfaces: [companion]
audiences: [adult]
triggers: [database check, test sql, sql migration, review criteria, review a pr, review pull request, pull request review, let athena review, company ai keys, repository review, request changes]
---

## What I can do

You can click a repository name in a workspace's **Pull Requests** card to
save its **Review Criteria**. I pass those criteria to the company-funded AI
review along with the PR description, discussion and changed-file patches.
The criteria belong to that repository in that company, rather than following
another company's similarly named repository.

Click a pull request to open its drawer. I show its description, comments,
inline discussion, review bodies and reviewers. Comments and reviews start
collapsed, showing only the author, date and time, and whether the entry is a
comment, approval or request for changes. Expand an entry to read its text and
file context; HTML markup is removed from the displayed description and discussion text.
**Let Athena Review** creates
a draft using the company's linked OpenAI or Anthropic API key and chosen
model. The review runs in the background, so you can close the drawer or leave
the page: **Athena's Agents** on the Work page and on that workspace shows it
working, its progress on a large pull request ("Part 2 of 4"), and whether it
finished. Click its row to reach the pull request. When it finishes, the
editable **Review text** box holds the result. I retain the generated draft with
its commit, criteria snapshot, provider and usage so you can reopen it.

When a pull request changes `.sql` files and your local work runner is on, I
first try them on a disposable copy of the company's sterilized database backup.
The runner restores the backup, runs the files in path order, and reports errors,
schema changes, row changes and timings, then deletes the copy. **Athena's
Agents** shows "Testing on a database copy" meanwhile. The result goes into the
review as evidence, and the top of the review says what ran and how old the backup
file is.

You decide what reaches GitHub. Edit the text, choose **Comment**, **Approve**
or **Request Changes**, review the prepared submission, then press
**Confirm submission**. The review is posted as the account owning the
company's linked GitHub token. Generating a draft never submits anything.

## Where to find it

Open **Work**, select the company, and use the **Pull Requests** card on
Overview or the **GitHub** tab. Click a repository heading to edit criteria;
click a PR row for details and review controls.

The pencil beside the workspace name (tooltip: **Edit workspace**) opens **Edit workspace**, which includes
workspace details, company credentials and review settings. **Company AI keys**
in the PR drawer opens the same workspace editor and returns to the PR when
closed. Add or replace an OpenAI/Anthropic key, choose the
company key and enter a model ID available to that account, then **Save review
provider**. You can revoke keys there too. If there is no saved review
configuration, a matching company development environment supplies the model
choice when available. Otherwise choose one explicitly.

## When it doesn't work

- **Let Athena Review is disabled.** The drawer explains whether a company AI
  key or a review model is missing, or a review is running. Use its add/configure
  button. A revoked key cannot be used.
- **GitHub access fails.** Link a company GitHub token under **Work →
  Development environments & keys**. Reading needs access to the repository;
  submitting reviews needs **Pull requests: write**. GitHub can reject an
  approval of your own PR or another unsupported reviewer transition.
- **The PR changed or closed.** Refresh it and generate a new review of the
  current commits. I recheck the commits before proposing and before posting.
- **Submission is unavailable.** Action authority consent and live Athena
  access must still hold. Each submission has its own recorded approval;
  standing approvals cannot submit reviews.
- **A company model call did not finish, or a review stopped partway.** Nothing
  was submitted. It may have incurred usage; check provider billing before
  retrying. I never restart a review by myself, and I do not retry on a different
  key or spend personal/core model funding.
- **The model used its whole output allowance.** It ran out of room before
  writing the review, which can happen when it thinks at length. The review
  fails and says so, with the usage recorded. Nothing was submitted.
- **The PR changed during the review.** I stop rather than mix two commits.
  Refresh and start a new review.
- **The review says the SQL was not run.** The work runner wasn't online, wasn't
  paired, or took more than eight minutes. Start it with `node runner.mjs` in
  `core_api/work-runner`, then start a new review. The review still finishes
  without the check.
- **The database check could not run.** If there's no backup for the company, put
  the backup file in `.athena-work/db-backups/<github-owner>/` under your home
  folder on the runner's computer, for example `vivacity-tech`. The newest file
  there is used.

## Limits

- A large diff is reviewed in parts and then combined. Each part and the final
  combination is a separate billed model call.
- I review the available diff and context; I do not check out code or run tests.
  The one exception is the database check, which runs only the PR's `.sql` files.
- The database check runs on the runner's computer with PostgreSQL 17. The backup
  stays on that computer and is never uploaded to me. The copy can lag behind
  production, and if the backup is trimmed, its row counts and timings won't
  match production. I run at most 20 SQL files, stop at the first failure, and
  cannot tell the intended order except by path. A pass is evidence, not proof
  that a script is safe on production. Output from the check goes to the
  company's AI key and into the retained draft.
  Large discussions, diffs, and missing/binary patches are explicitly flagged
  as incomplete context. This is a review aid, not a claim that a PR is safe.
- Each discussion endpoint reads at most 300 entries, each comment up to
  30,000 characters and the description up to 60,000. AI context includes up
  to 100,000 patch characters, 30,000 discussion characters and 20,000
  description characters. Limits are disclosed in the generated draft.
- Criteria allow 16,000 characters; submitted review text allows 32,000.
  Editing the generated text stays in the open drawer until submission.
- I use only keys linked to the selected company. The AI provider funds the
  draft; the GitHub credential determines who posts it. I cannot create an
  independent GitHub identity named Athena.
- Drafts and submissions are pinned to head and base commits. A changed
  company GitHub credential also requires preparing a new submission.
- I submit a top-level PR review. I do not merge, deploy or add inline review
  annotations through this interface.

## Under the hood

- Backend: `src/services/workspaceReviews.js`, `src/controllers/workspaceReviews.js`;
  routes in `src/routes/companion.js` under `/dashboard/workplaces/:uuid/`:
  `GET|PATCH review-settings`, `GET|PATCH repository-review`, `GET pull-request`,
  `POST pull-request/draft`, `POST pull-request/propose`.
- Background: one Cloud Task per pass reaches `POST /internal/workspace-review/pass`
  with the Guardian dispatch's caller check. A pass fits one 300 s request (40,000
  patch characters, 16,000 output tokens, 240 s model timeout). The diff is re-read
  from GitHub each pass and never stored; per-part notes persist between passes
  and are cleared when the review finishes. An atomic claim makes a redelivered
  task a no-op, and past the caller check the route always answers 200, so a
  pass is never billed twice. Without Cloud Tasks the pass runs in process.
- Database check: `work-runner/dbCheck.mjs`, driven by the runner's existing poll
  through `POST /work-items/review-checks/claim` and `/:uuid/finish`. Those accept
  only the device paired as "Work runner", which gets the SQL at the reviewed
  commit and no keys. The container has `--network none` and no host mounts. A
  queued review books its first pass eight minutes out as a backstop; the runner's
  result books it at once, and the pass claim keeps that to one run. A later
  result is dropped. The summary at the top of the review is built by code.
- Persistence: `db/migrations/0104_workspace_reviews.up.sql`,
  `0105_workspace_review_passes.up.sql` and
  `0106_workspace_review_db_check.up.sql` store company/repo criteria, company
  review configuration, provider usage/draft snapshots and pass progress.
  A nullable unique active slot prevents simultaneous paid reviews of a PR;
  in-flight records with no progress for ten minutes become unknown and are
  never restarted. Secrets stay in encrypted user credentials. No migration is
  run by the request handlers.
- Credential ownership is checked using `src/services/workItems/store.js`;
  model calls use `src/services/llm/adapters/workProvider.js` with its live
  access guard. There is no provider fallback.
- Publishing: `src/services/actions/workspaceReview.js` is registered in
  `src/services/actions/registry.js`. Existing attempt/confirm/execute/audit
  handles each submission; standing and direct execution are disabled. The
  exact approved body, event, company key and commits are revalidated before
  one GitHub create-review request. No provider-write retry is automatic.
- Frontend: `../../../companion/src/components/WorkspaceReviewDrawers.tsx`,
  `../../../companion/src/components/WorkspaceSettingsDrawer.tsx`,
  `../../../companion/src/components/WorkspacePage.tsx`,
  `../../../companion/src/api/workspaceReviews.ts`. Shared encrypted key form:
  `../../../companion/src/components/CompanyCredentials.tsx`, also used by
  `../../../companion/src/components/WorkItems.tsx`.
- Tests: `src/services/workspaceReviews.test.js`, `work-runner/tests/db-check.test.mjs`,
  `work-runner/tests/db-check-smoke.mjs` (real Docker); existing action and company
  provider guard suites. UI fixtures: `../../../companion/mock/workspaceReviews.ts`.
