# Jira work items and local development environments

Review and implementation proposal, 2026-10-25. First testing target: Monday,
2026-10-26, America/New_York. This is a design, not a shipped capability.

## Confirmed first-test configuration

Owner-supplied on 2026-10-25:

| Setting | Selected value |
| --- | --- |
| Client | Vivacity Tech PBC; company-owned provider keys, direct provider billing |
| Frontend | `https://github.com/Vivacity-Tech/Dream-Frontend` |
| Backend | `https://github.com/Vivacity-Tech/Dream-Backend` |
| First issue | [DRM-9902](https://vivacitytech.atlassian.net/browse/DRM-9902) |
| Backup source | `gs://dream-db-exports/sterilized/` |
| PostgreSQL | Major version 17 |
| Demo video destination | Google Drive folder `https://drive.google.com/drive/folders/1OT9MtAPYjtC6CVZ7-v8llA_daA6GHgPU` |
| Pull requests | One per changed Dream repository, body following that repository's `.github/pull_request_template.md` |
| Publishing approval | Separate `publish_work_item` approval, given only after the owner reviews the video and diff |
| Core-funded model work | Athena orchestration and Athena's voice |
| Company-funded model work | All remaining work-item model calls, including planning, code investigation, implementation, debugging, verification and demo-script generation |

Orchestration means job coordination, status and approval handling, not a way to
route substantive ticket analysis through core keys. Enforce this split in code
by operation type, not a model-supplied payer field. Every call still carries
the run/client attribution alongside its actual payer. A company-key outage
must block company-funded operations instead of falling back to core keys.

These identifiers are confirmed inputs, not evidence of successful source access,
backup restoration or ticket inspection. Exact backup format/object, branches,
extensions, startup configuration and test login still need validation. The
`sterilized` prefix is the selected test-data source; verify its contents and
sanitization before relying on it.

## Recommendation and first test

Add a client-owned work-item workflow to Companion `/work`, backed by a durable
job service and a separately paired local Docker runner. Reuse workplaces,
encrypted credentials, action approvals, push transports, project acceptance
criteria conventions, and Athena's existing voice. Keep this workflow separate
from Athena's self-repair agents and their four-repository allowlist.

The first useful test is one small Dream issue through this sequence:

1. Open the issue in a sidebar; read its description, acceptance criteria and
   comments without leaving Work.
2. Select the saved **Vivacity / Dream local** environment, which includes both
   Dream-Frontend and Dream-Backend plus a restored PostgreSQL service.
3. Click **Plan**, review the resources, provider, cost limit and operations
   being authorized, and confirm that scoped planning action.
4. The local runner checks out pinned revisions, restores a selected backup,
   starts services, checks health and baseline tests, and investigates. It
   produces a plan and evidence or a precise blocked report.
5. Receive an in-app notification and, when permitted, a push with a link back
   to the plan. Review, request revisions, reject, or **Approve & implement**.
6. Approval records the exact plan revision, posts that approved text to Jira,
   then makes changes in the run's isolated checkout. No implementation starts
   if comment publication is unresolved.
7. Review the diff, test results, acceptance-criteria evidence and a real browser
   recording narrated using Athena's configured voice. Download a patch and
   inspect the local preview. Request revisions, reject, or continue to publish.
8. Click **Publish**, review the exact upload and pull request bodies, and
   confirm the separate `publish_work_item` action. Athena uploads the video
   to the configured Drive folder, pushes a
   branch to each changed Dream repository, and opens pull requests whose
   bodies follow each repository's template with the Jira and Drive links.
   Approving the plan or the implementation never authorizes publishing.

Begin testing the drawer, setup and planning as soon as that slice is ready.
The complete recorded implementation is a conditional stretch target for the
first day, dependent on the actual repositories, backup and application login.
Do not promise the full workflow before the first environment boots.

## Evidence from this checkout and database

The configured Athena MySQL database was inspected with read-only transactions.
No credential ciphertext or plaintext token was selected. No production data,
grants, credentials, Jira comments, repositories or containers were changed.

| Area | Observed state | Consequence |
| --- | --- | --- |
| Work ownership | Vivacity Tech PBC exists as the primary workplace, with role Senior Software Developer; Orcwood Games LLC exists separately | Reuse workplace IDs for client ownership rather than creating a second company list |
| Jira | One active API-key Jira credential is linked to Vivacity | Reuse that connection, but verify detail/comment permissions against a test issue; active metadata does not prove live access |
| Development/model credentials | No GitHub, OpenAI or Anthropic rows in `user_credential` | Setup must collect or connect these; this says nothing about separate platform-level secrets |
| Schema | Latest recorded migration was `0097_project_execution`; workspaces, workplace links and project work sessions exist | Allocate new migration numbers at implementation time; `0098` already exists as an uncommitted migration |
| Work-item execution | No dedicated work environment, sandbox job, artifact or client usage ledger tables found | These need new storage; project work sessions schedule human work and are not container jobs |
| Usage | `llm_call_log` has task/model/latency/outcome and input/output character counts; recent rows are populated | Existing telemetry cannot produce an accurate ticket/client token bill or reconstruct one historically |
| Notifications | Push enabled; quiet hours 22:00–06:00 Eastern; registered web, SMS and Android FCM-actions destinations | Reuse push transport and consent. Registration is not a successful end-to-end delivery test; do not send SMS by default |
| Local tools | Docker Desktop Linux engine responds, Engine 27.5.1; Node and PostgreSQL client present | A local runner is feasible; app runtime versions must come from Dream, not the host tools |
| Voice | Existing Gemini TTS uses configured `GEMINI_TTS_VOICE`, default Aoede | Reuse this service; OpenAI/Claude coding keys do not fund Gemini narration |

The checkout contains substantial uncommitted project execution and trading
notification work. It was reviewed as existing work, not altered. In particular,
the project execution engine derives ready steps and blockers; it is not a
coding-agent/container executor. Trading notification outbox code is useful as
a design reference but is not a shared stable job service and its migration was
not among the applied migrations observed.

The Dream repository URLs, first issue, backup prefix and PostgreSQL major version
were subsequently supplied above; their contents have not been inspected. No
claim is made yet about their build commands, startup dependencies, test
coverage, PostgreSQL extensions, restore time, or acceptance-criteria field.

### Existing components and code to reuse

- `companion/src/components/WorkPage.tsx`: workspace cards, Jira preview,
  agents activity. Preview issue rows currently open external links.
- `companion/src/components/Dashboard.tsx`: `/work` detail and shared `Issues`
  list; its Jira rows also open external links. Both Work entry points need
  the same issue-open callback.
- `companion/src/components/Drawer.tsx`, `ActionControls.tsx`,
  `IntegrationsPanel.tsx`, `Projects.tsx`, `ProjectExecution.tsx`: existing
  slide-over, controls, credential connection patterns and review conventions.
  Add focus management if needed for the new drawer; preserve mobile behavior.
- `core_api/src/services/connectors/work.js` and `jiraApiToken.js`: both Jira
  transports currently fetch only summary/status/project/updated/due fields.
  They return no description or comments, and OAuth results lack a stable
  connection/cloud identity in the UI contract.
- `core_api/src/services/workplaces.js`: explicit ownership and credential links.
  Linking currently does not route provider calls through a workplace's key.
- `core_api/src/services/credentials.js`: encrypted, audited credential storage
  with public metadata responses. Supports OpenAI storage; GitHub and Anthropic
  appear as workplace labels but are not currently accepted credential providers.
  The integrations panel has no generic OpenAI/Claude key entry flow.
- `core_api/src/services/actions/`, controllers/routes: recorded proposal,
  confirmation, live authorization and audit. Pending proposals have short
  expiry; generate a fresh confirmation when the person reviews a ready plan.
- `core_api/src/services/llm/`: guarded adapters, routing and telemetry. The
  OpenAI-compatible adapter already returns usage, but the generic router does
  not propagate it into billing. There is no native Anthropic adapter here.
- `core_api/src/services/openaiBilling.js`, `gcpBilling.js`: platform cost
  summaries, not per-client or per-ticket accounting. Retain that purpose.
- `core_api/src/services/push/`: consent-aware transport and per-event keys;
  `services/trading/notifications.js` demonstrates persistent delivery attempts.
- `core_api/src/services/gemini.js`, `llm/adapters/gemini.js`: existing speech.
  The HTTP speech route has an 800-character limit; use bounded narration
  segments through a guarded server job rather than one long HTTP request.
- `core_api/src/services/codeAgents.js`: existing self-repair restrictions.
  Do not add Dream repositories to this allowlist or reuse its privileged token.

Workspace-root `AGENTS.md`, `core_api/AGENTS.md`,
`docs/architecture/action-layer.md` at the workspace root, and
`core_api/docs/capabilities/README.md` govern implementation. The policy's
`core_api/docs/architecture/action-layer.md` reference does not exist in this
checkout; the document is in workspace-root `docs/architecture/`.

## UI and environment setup

Open Jira issues in a reusable right-hand Drawer with tabs **Issue**, **Plan**,
**Run**, and **Evidence**. Support refresh, comment pagination, loading/failure
states, and a shareable URL carrying the issue's connection identity and key.
Retain **Open in Jira** as a secondary action. A cloud/site plus issue key is
the identity; an issue key alone is not globally unique.

The Issue tab includes description, status, assignee, priority, parent/subtasks,
links, attachment metadata, comments with authors/timestamps, and acceptance
criteria. Render Atlassian Document Format through safe React nodes; the small
existing Markdown renderer is not an ADF renderer. Do not render provider HTML
or fetch arbitrary attachment URLs. Add authenticated attachment reads only
where needed. Let the user select the actual Jira acceptance custom field in
setup, with a reviewed description-derived fallback when none exists.

Under **Work → Vivacity → Manage → Development environments**, allow named
environments with reusable repository and database resources. A single selected
environment can include multiple repositories; Dream FE and BE are components
of the same running system, not mutually exclusive choices.

Environment revision fields:

- Workplace, label, paired runner and allowed Jira connection/project(s).
- GitHub repository URLs/IDs, explicit read credential, base branch, relative
  checkout directory, runtime/build recipe, install/start/test commands, ports,
  dependency ordering and health checks.
- PostgreSQL image major version, database name, required extensions, backup
  bucket/prefix or explicit object, format/compression and restore recipe.
- Explicit test configuration and secret references, seeded test login, fixture
  or redaction policy, and disabled outbound mail/payments/webhooks/schedulers.
- Provider, model, credential reference, payer mode, narration funding, approved
  spending ceiling, CPU/RAM/disk/time limits, cleanup and artifact retention.
- Acceptance-field mapping and demo entry URL/scenario configuration, including
  the demo login's role. Dream's PR template forbids demonstrating as Vivacity
  Admin unless the ticket concerns the Dream Administration module; record the
  minimal role needed per scenario and refuse to record as admin otherwise.
- Publishing: Drive destination folder (in a Shared drive) and the upload
  service account added to it, or the manual-upload fallback; GitHub write credential and PR base branch per repository; path to
  each repository's PR template and Husky `commit-msg` hook (the naming rules).

**Test environment** checks source access, backup readability and type, restore,
database connectivity, builds, frontend/backend health and baseline tests. Show
each check and logs. Only a successful tested revision should be labeled ready.
Changes create a new revision and cannot silently modify an active run.

Each run pins repository SHAs, environment revision, image digests, and GCS
object generation/checksum. Show the chosen backup's age and size. A bucket
alone is insufficient: a logical SQL/pg_dump export can be restored locally;
a managed Cloud SQL backup is a different restore path and may require first
producing a suitable export. Check extensions, ownership, disk and memory
before attempting the first large restore.

## Local runner and approval boundary

The hosted core API owns identity, approvals, run state, provider credentials,
usage and artifacts. A small owner-paired local daemon polls over outbound
HTTPS, leases jobs and uploads logs/results. No public Docker socket or inbound
port forwarding is needed. Pairing/revocation and per-run ownership are enforced
server-side; runner tokens cannot query arbitrary profiles or jobs.

The daemon alone controls Docker. It creates a dedicated Compose project per
run: FE, BE, PostgreSQL, and a browser/test service as required. Checkout lives
in a named volume and survives container recreation. Reuse cached base/dependency
layers; do not rebuild an entire image for every edit or embed backups in image
layers. Create PostgreSQL volumes independently. Preserve a baseline checkout
or snapshot and resulting diff for comparison.

Containers run without privileged mode, host networking, host home directories,
deployment credentials or Docker socket mounts. Separate credentialed fetch and
restore preparation from untrusted application/agent execution. Read GitHub and
GCS credentials only in the broker/preparation boundary and remove them before
running repository scripts. Supply only intended application test secrets.
Use enforced network rules/proxying for runtime egress; an ordinary Docker bridge
does not itself prevent internet or host access. Block production services and
cloud metadata endpoints. Docker isolation is not a complete boundary for
arbitrary hostile code; start with owner-approved repositories and recipes.

Introduce new scoped actions, provisionally `plan_work_item`,
`implement_work_item` and `publish_work_item`, none eligible for standing
approval in the first version.
Their normalizers validate server-owned run, environment and plan references,
not arbitrary shell commands, URLs or credentials. A UI click records the same
propose/confirm/audit sequence as chat approval. No new autonomous path bypasses
the action layer, and no existing action's accepted scope is widened.

The planning approval covers checkout, restore, known build/test recipes and
bounded debugging inside this environment. Planning must not apply proposed
product changes to the implementation checkout; diagnostic experiments, if
needed, occur in a disposable scratch copy and are reported. Baseline failures
may yield a diagnosis/blocked plan, never a claim that startup passed.

Implementation approval binds the reviewed plan hash/version, acceptance snapshot,
repository SHAs, environment revision, coding provider/key and spending ceiling.
It explicitly includes the exact Jira comment and local modifications/test
execution. Store that confirmed parent action with every job operation. Any
model-requested operation outside its recorded scope becomes a new proposal for
human approval. Tool loops return proposals to a trusted broker, never execute
model-produced commands directly. The first version should use a finite catalog
of file/test/browser operations and owner-reviewed recipes, not an unrestricted
agent shell. Runtime validation rejects path traversal, symlink escapes, alternate
repositories, production targets and credential reads.

Every model dispatch, including async work and TTS, must use guarded adapters
and re-check the approved actor's live access. A job must not inherit blanket
authorization merely because a runner or background account is configured.
Use a server-rehydrated verified identity/run context; do not trust model or
worker-supplied profile IDs. Buying one's own key does not waive Athena access.

`publish_work_item` is proposed only from `ready_for_review` and binds the
reviewed diff hash, final commit SHAs per repository, the video artifact hash,
the Drive folder, target repositories/base branches, branch
names and the exact rendered PR bodies. It is the only action that pushes to a
Dream repository or writes to Drive; implementation never pushes. Any change to
the diff, video or bodies after review invalidates the proposal and requires a
fresh one.

Before implementation, check for Jira issue changes and stale code/environment
snapshots. Invalidate/review the plan where the approved scope changed. Explicit
revocation, Stop, exhausted budget, expired lease or unavailable credentials
pauses the appropriate operation and records a reason. Keep work/diffs available.

This feature requires additions in protected action, provider and runner
permission code. Those are explicit owner-feature changes to review as such,
not self-improvement permission. Preserve all current Guardian checks, self-repair
repository/account limits and required protected-path CI.

## Durable execution and failure recovery

Use persisted phases:

`queued → preparing → checking_baseline → planning → awaiting_review →
posting_plan → implementing → verifying → recording_demo → ready_for_review →
uploading_demo → opening_prs → published`

Everything after `ready_for_review` runs only under a confirmed
`publish_work_item`.

Each phase can enter `blocked`, `failed` or `cancelled`; resume creates a new
attempt with the same immutable approved inputs or requires approval of changed
inputs. Revision requests produce a new plan revision, never edit an approved
plan in place. Local runner offline is visible and queued; the UI does not wait
on a long HTTP request. Poll status initially; reuse the existing socket update
conventions later if useful.

Store leases, heartbeats, attempt IDs and compare-and-swap state transitions.
Fence stale workers before accepting results or initiating any external write.
Crash recovery reconciles the last checkpoint instead of starting a second job.
Start with one concurrent run on this machine; explicitly queue every request.
This is resource scheduling, not notification suppression.

Jira comment publication is brokered server-side from the stored approved text,
with a run/plan revision marker or comment property and stored remote comment ID.
After a timeout, inspect Jira for the marker before retrying. A local unique key
alone cannot guarantee exactly once across a remote API. If the result remains
ambiguous, block/reconcile rather than posting again blindly. Comment failure
does not discard the approval, plan or environment; expose a safe retry.

Publishing writes follow the same reconcile-before-retry rule. Drive uploads
carry the run/attempt in `appProperties`; after a timeout, search the folder for
that property before uploading again. Before pushing or opening a PR, look up an
existing branch and open PR for the run's branch name and reuse it. Uploads
complete before any PR is opened, because the PR body needs their links.

Notifications use a durable outbox written with the ready/blocked transition.
Deep-link to the exact run/revision. Reuse current push consent, per-occurrence
dedupe, mute and quiet-hour semantics; hold quiet-hours pushes for later delivery,
without another trigger piercing quiet hours. Use a unique notification key per
run transition, never a shared collapse key. Persist in-app readiness regardless
of push delivery; show delivery failures and retries. Reuse transport, not
trading-specific cooldown/filter rules.

## Proposed storage and service boundaries

Names are provisional; add migrations after reconciling ongoing work.

| New storage | Purpose |
| --- | --- |
| `athena_work_environment` and immutable revisions | Workplace-owned configuration, resource mappings and validation results; no inline secrets |
| `athena_work_runner` | Owner pairing, hashed revocable token, capabilities, heartbeat and capacity |
| `athena_work_item` | Jira credential/site/issue identity and workplace relationship |
| `athena_work_run` | Phase, actor/workplace, snapshot references, approved action IDs, parent attempt, lease and checkpoints |
| `athena_work_plan` | Immutable plan versions, hash, assumptions, criteria, baseline evidence and approval binding |
| `athena_work_event` / artifacts | Append-only state/operation history; authorized artifact paths, hashes and metadata, including Drive file IDs/links |
| `athena_work_publication` | Per-repository branch, rendered PR body hash, PR number/URL, linked dependent PR and the confirmed publish action |
| `athena_work_usage` | Per-provider-call billing ledger and reconciliation status |
| `athena_work_notification` / deliveries | Ready/blocked/complete outbox and per-destination delivery attempts |

Reuse `user_credential` for encrypted keys, with explicit account identifiers so
adding Vivacity's key does not overwrite another workplace's key for the same
provider. Reuse exclusive workplace credential links. Credential selection must
use an exact owned UUID plus matching workplace/provider/status, not the current
"latest active credential for this provider" fallback. Enforce ownership and
cross-resource integrity in service queries and suitable composite constraints;
profile ownership alone is insufficient when two clients belong to one person.

Proposed implementation modules:

- `core_api/src/services/workItems/`: store, environments, plans, jobs, usage,
  notifications and artifact access; controller/routes for issue/run/setup views.
- Jira detail, comments and permission reads alongside current connector readers;
  an approved comment writer behind the new action and existing credential audit.
- A Drive uploader (impersonated service account, `drive.file` scope) and a
  GitHub branch/PR writer, both
  reachable only from the confirmed `publish_work_item` action, plus a PR-template
  renderer that fills a repository's template from run evidence.
- Workspace-bound provider dispatch through the model layer; native Anthropic
  adapter, OpenAI configuration binding, usage normalization and explicit fallback.
- A separate `work-runner/` package for local pairing, polling, Docker preparation,
  approved operation execution, checkpointing, artifacts and demo capture.
- Companion issue/environment/run drawers, API types, mocks and Work callbacks.
- Private artifact storage: local retained copies plus authenticated uploads to
  the application's controlled storage for hosted UI/mobile access. Do not serve
  arbitrary host paths or rely on a remote user's browser reaching localhost.

## Provider keys and client billing

In the workspace setup offer **OpenAI API key** and **Anthropic API key**, with
provider/model, key label, payer and cost ceiling. Save write-only via TLS, mask
after entry, encrypt using the existing keyring, audit reads/changes and allow
revoke/replace. Never persist keys in browser storage, job payloads, Git, image
layers, logs or model prompts. Validation calls must use the same authorization,
workplace attribution and usage path as normal work.

All planning, coding, debugging, retries, validation and demo-script calls carry
`profile_id`, `workplace_id`, issue/run/attempt, phase, provider/model, credential
reference, request ID, actual input/output and cache/reasoning usage where
reported, rate-card version, currency and estimated cost. Include rejected or
failed attempts when the provider reports billed usage. Missing usage is unknown,
not zero; record for reconciliation. Persist dispatch intent before a call and
its usage before scheduling the next one. Recover unreconciled calls without
blindly repeating charged requests. Store monetary arithmetic in decimal or
integer subunits, with cache/reasoning categories normalized to avoid double counts.

The selected first-test payer is a Vivacity-owned provider key/project:

- **Vivacity-owned key/project:** provider usage is charged to that provider
  account/project; Athena still records ticket-level attribution. Personal-key
  reimbursement is not needed for this first version.
- **Core-funded orchestration and voice:** explicitly authorized by the owner.
  Keep those calls attributed to the work item but separate from company-paid
  usage. Actual invoice/payment collection is a separate accounting feature,
  not established by the current code.

No silent fallback to Orcwood/global keys. A missing/revoked client key blocks
with a setup explanation. Fallback between client providers requires an explicit
configured choice. Reserve budget across concurrent calls, reconcile after each
response and pause before further calls when exhausted. Include all attempts,
not just the final successful answer. Historical character logs cannot be
retroactively converted into authoritative token charges.

Athena voice currently uses Gemini. Use the owner-authorized core-funded route
for narration and show its payer and cost as a separate line. Do not imply an
OpenAI or Claude company key funds it. Only orchestration and voice have this
core-funded exception; substantive work-item inference uses company credentials.
Video processing/storage/download costs should also remain distinguishable from
model token charges.

## Acceptance evidence and narrated video

Capture acceptance criteria before planning and map each criterion to a concrete
check. After implementation, collect baseline comparison, tests, diff and actual
browser/API evidence tied to resulting commit/content hashes and database fixture.
Use Playwright assertions for browser behavior and appropriate service tests for
backend criteria. Generate the walkthrough from the verification results and
actual run trace, not just the agent's account of what it changed.

Record the real local app in a separate browser context. Finalize browser video,
generate short Athena TTS segments, and mux them with captions/timestamps using
FFmpeg. Preserve source recording and test trace. A criterion that fails or
cannot be observed is failed/unverified, never narrated as passed. Backend-only
criteria need API/DB/test evidence in addition to anything shown on screen.
Video failure leaves code/test artifacts reviewable but explicitly marks the
demo incomplete. Tests passing is not final human acceptance.

Provide an inline player plus diff, logs, preview, criteria table and downloadable
patch. Protect recordings and restored client data with the same owner/workplace
scope as the job. Use test accounts and sanitized fixtures by default. Retention
and deletion cover DB volumes, checkouts, logs, raw traces, audio and videos;
retain only required audit metadata after content deletion.

Verification also captures what the PR templates require: for Dream-Backend,
whether API endpoints changed and whether the OpenAPI/swagger spec was updated to match
(`docs/standards/API_DOCUMENTATION.md`). For Dream-Frontend changes touching
`*.entries.json` or `scripts/contentstack/**`, run `npm run cs -- check` and
record its result. Implementation prompts include
`docs/standards/confluence_mirror.md` from each repository as the coding
standard.

## Publishing: Drive upload and pull requests

Publishing is the `publish_work_item` action described above, run only after the
owner has reviewed the video, diff and evidence.

### Drive upload

- Upload the final narrated video to
  `https://drive.google.com/drive/folders/1OT9MtAPYjtC6CVZ7-v8llA_daA6GHgPU`.
  Name files from the issue key and run, e.g. `DRM-9902 demo (run 42).mp4`.
- No user OAuth into Vivacity's Drive. Upload as a dedicated service account
  instead, e.g. `work-item-uploader@athena-476423.iam.gserviceaccount.com`,
  that has no other roles. Vivacity adds that one address to the destination
  with upload rights only (Contributor), and can remove it at any time.
  - Service accounts have no Drive storage quota of their own, so this works
    only if the folder is in a **Shared drive**. Uploads into a folder in
    someone's My Drive fail. If the folder is in My Drive, Vivacity moves it
    to a Shared drive or provides one.
  - Vivacity's Workspace may block sharing with accounts outside its domain.
    If it does, an admin allows this one address, or Vivacity creates the
    service account in its own GCP project and grants Athena's runtime
    permission to impersonate it.
  - Use keyless impersonation (`iam.serviceAccountTokenCreator` on that single
    account for the work-item job's identity), with short-lived tokens scoped to
    `drive.file`. Don't create a JSON key, and don't use domain-wide delegation.
  - Only the confirmed `publish_work_item` path can mint the token. Setup tests
    it by uploading and deleting a small file, which also proves it can write.
  - Fallback when none of that is possible: publishing pauses at
    `uploading_demo`, the owner downloads the video from the run and uploads it,
    then pastes the Drive link, which becomes part of the reviewed PR body.
- Do not change the folder's or file's sharing. The PR links to the file as-is;
  verify during setup that the Dream reviewers (`@Vivacity-Tech/development-leads`)
  can open files in that folder. The video contains restored client data, so
  never make it link-public.
- Store the Drive file ID, link, checksum and uploading credential on the run's
  artifact record. Upload cost is a separate line from model usage.

### Pull requests

- One branch and PR per changed repository, pushed from the run's isolated
  checkout at the approved commit. Use a dedicated Vivacity GitHub credential
  with push and PR rights on Dream-Frontend and Dream-Backend only; never the
  self-repair `codeAgents` token or allowlist. Open as ready for review (not
  draft) so Dream-Backend's `claude-pr-review.yml` requirements and security
  reviewers run; that workflow needs the Jira link in the body.
- Branch and commit names follow each repository's `.husky/commit-msg` and
  `.husky/pre-push`, read at the pinned SHA. As of 2026-10-25:
  - Branch: `<KEY>-<number>-<Feature|Bug|Hotfix>`, e.g. `DRM-9902-Bug`. Use the
    same name in both repositories; a repository suffix such as `-FE` is
    rejected. Derive the type from the Jira issue type (Bug → `Bug`, otherwise
    `Feature`); `Hotfix` only when the owner chooses it in the publish review.
  - The `-QA`/`-STAGE` suffix marks environment-exception branches that PR into
    QA or STAGE instead of `main`; the default is a plain branch into `main`.
  - Commit subject: `<branch name> <specific message>`, e.g.
    `DRM-9902-Bug keep filter state after pagination`. Don't use the legacy
    `DRM-9902:` form.
  - The two hooks differ: Backend also allows `VORG` and `<n>-Bugfix` and caps
    numbers at 5 digits; Frontend allows only `VAL|DRM|TI`. Generate names that
    satisfy both: the `<KEY>-<n>-<Type>` form.
  - Validate names in code before committing, and let the hooks run; never
    commit with `--no-verify`. Both repositories' `pre-commit` hooks run
    `git add -A .`, so every file in the checkout is committed. Keep recordings,
    traces, logs and scratch files outside the repository checkout, and check
    that the committed tree equals the reviewed diff before pushing.
- Render each body from that repository's own
  `.github/pull_request_template.md`, read at the pinned SHA, filling its
  sections rather than replacing them. When a repository has no template, use a
  short Jira/video/description/tests body. For the current Dream templates:
  - **Link to Jira Ticket**: the issue's browse URL.
  - **Link to Video Demonstration**: the Drive link from the upload step.
  - **Written description of changes**: specific changes and reviewer notes,
    drafted from the diff and verification evidence, never "Fixed bug".
  - **Extra**: tick "Does this PR have dependent PR?" when both repositories
    changed, and link each PR to the other (open both, then edit both bodies).
    Leave "Can this PR be merged immediately" ticked unless the plan says
    otherwise, with the reason.
  - **API documentation** (Backend): tick both boxes only when the endpoint
    check above found changes and the spec was updated; a changed endpoint
    without a spec update blocks publishing.
  - **ContentStack** (Frontend): record the `cs -- check` result when relevant.
  - **Other Information**: environment variables, LaunchDarkly flags or
    Confluence links that the plan or diff introduced.
  - **Requirements**: the template's unit-test screenshot requirement is
    deprecated (owner, 2026-10-25); do not produce one. Test results stay in the
    run's evidence and the description may summarize them.
- The owner sees and approves the exact rendered bodies in the publish
  confirmation. The PR description is company-funded model work.
- Athena never merges, approves or requests changes on Dream PRs; CODEOWNERS
  review and Dream's own CI decide from there. Record PR URLs on the run and in
  the ready/published notification.

## Implementation order and test target

Estimates are engineering ranges, not unattended delivery promises. Repository
access, restore size, authentication and baseline health can move them substantially.

| Order | Concrete deliverable | Approximate focused effort |
| --- | --- | --- |
| 1 | Jira detail/comment reads and both Work entry points opening the drawer; environment/key setup with ownership checks and mocks | 4–8 hours |
| 2 | Durable planning action/job, local pairing and runner, Dream FE+BE+Postgres recipe, health/baseline report, reviewable plan, notification and usage ledger | 6–12 hours after access/recipe inputs are ready |
| 3 | Version-bound approval, reconciled Jira comment, bounded local implementation, verification and patch review | 6–12 hours |
| 4 | First scripted acceptance video with Athena voice, artifact upload/player and cost attribution | 3–6 hours for a working scripted scenario |
| 4b | `publish_work_item`: service-account Drive upload (or manual-link fallback), hook-valid branch/commit names, template-rendered PR bodies, branch push and PR creation with reconciliation | 4–8 hours |
| 5 | Recovery, revocation, isolation, redaction, accounting reconciliation, broader issue coverage and operational hardening | Additional multi-day work |

For October 26, prioritize order 1 and the smallest working planning path in
order 2. Build incrementally so testing can start with issue details and setup
while runner integration continues. Use one model provider first for the first
complete run; validate the second before declaring both supported. The complete
approve/implement/video path is the next milestone, or a first-day stretch if
the environment is already straightforward and enough implementation time exists.

Each shipped increment updates the relevant capability file (`jira.md`,
`workplaces.md`, `actions.md`, or a new work-items capability) and LEDGER in
`core_api`. Keep unfinished features `planned` and partial ones honest. No live
capability change accompanies this proposal alone.

### Required validation before a real ticket is trusted

- Read permissions on description, paginated comments and selected acceptance
  field; safe ADF, attachments and connection-qualified issue identities.
- Cross-profile, cross-workplace, revoked-key, unauthorized runner and fabricated
  job/action/plan references fail closed. New provider calls retain live access
  checks. Existing self-repair restrictions remain pinned by their tests.
- No unapproved Jira write or product patch. Changed/stale plans cannot reuse
  approval. Duplicate clicks, expired proposals and stale runner leases cannot
  create duplicate work or accept stale results.
- Failed restore/build/health/login produces a specific blocked result and no
  claimed success. No production API, credentials, email or webhook is reachable
  from the test stack. Test outbound restrictions, not just configuration labels.
- Kill/restart the daemon at each checkpoint; reconcile ambiguous Jira writes
  without duplicate comments. Stop/revoke prevents further operations. Cleanup
  cannot delete another run or escape the managed workspace.
- Actual provider usage from every attempt appears on Vivacity's run; client keys
  cannot fall back to another payer. Unknown usage and narration funding are
  visible. Exhausted/reserved budget pauses future work.
- Ready plans persist offline; quiet hours hold pushes; distinct ready events
  stack. Verify one actual browser/phone delivery during testing.
- One real Dream issue demonstrates a criterion failing at baseline and passing
  after the patch, with video, trace and narrated statements matching evidence.
- No push, PR or Drive write happens without a confirmed `publish_work_item`
  bound to the reviewed diff, video and bodies; a changed artifact invalidates
  it. Retried publishing finds the existing Drive file, branch and PR instead
  of duplicating them. A demo recorded as Vivacity Admin for a non-admin ticket,
  or a changed endpoint without a spec update, blocks publishing.
- The rendered PR body passes Dream-Backend's requirements reviewer (Jira link
  found) and a development lead can open the Drive video from the PR.
- Generated branch and commit names pass both repositories' Husky hooks with
  hooks enabled, and the pushed commit contains only the reviewed diff.

Baseline checks run during this review: 45 tests passed across workplaces, Jira
OAuth summary, Jira API-token summary and codeAgents suites; Companion's 16 work
status tests passed. These establish the existing baseline, not the proposed
workflow. No new runtime code was built or tested.

## Inputs needed for the first Dream run

1. Repository branches and access method for the confirmed FE/BE URLs; inspect
   DRM-9902 to validate its acceptance field and choose the demo scenario.
2. Exact object/selection rule and format under the confirmed sterilized prefix,
   whether it is a logical export or managed backup, PostgreSQL 17 extensions,
   approximate size, and verification of the local test-data approach. Supply
   read access restricted to the backup
   resource; do not give the runner deployment/owner credentials.
3. Build/start/test commands or existing development Compose instructions; required
   test configuration and a test login/scenario for the browser walkthrough.
4. Choice of provider/model and the company-owned API key. Direct company billing
   and core-funded orchestration/voice are confirmed. Keys should be entered in the new
   protected UI, never pasted in Jira or this plan. If setup must precede that UI,
   use an owner-run secure credential import.
5. Machine/runner availability, storage and memory for the restore, plus the
   target time tomorrow for the first hands-on test.
6. For publishing: whether the Drive folder is in a Shared drive, whether
   Vivacity will add the upload service account (or allow one outside its
   domain), and whether the development leads can open it; a GitHub credential with push/PR rights on
   both Dream repositories; confirmation that normal branches PR into `main`
   (the hooks imply it; the review workflow covers `main`, `TEST`, `STAGE`,
   `PROD`); and the minimal demo role for DRM-9902.

## Verified external references

- [Jira issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/): paginated reads, ADF comment payloads, and Add comments/project permissions. OAuth currently requests only `read:jira-work`; writing requires an explicitly consented appropriate write scope and project permissions. The API-token connection's write ability must be tested, not inferred from a successful read.
- [OpenAI API overview](https://developers.openai.com/api/reference/overview): API keys and organization/project attribution. [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create): usage response contract; retain provider-reported usage rather than estimating bills from characters.
- [Anthropic Messages](https://platform.claude.com/docs/en/build-with-claude/working-with-messages): native request/response format and token usage; do not assume OpenAI wire compatibility.
- [Playwright videos](https://playwright.dev/docs/videos): real browser recording and finalization on browser context closure. Narration/muxing is additional work.
- [PostgreSQL pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html): supported archive restore, version/options and execution implications; restore only inside the isolated test boundary. [Cloud SQL exports/imports](https://docs.cloud.google.com/sql/docs/postgres/import-export/import-export-sql) and [managed backup restoration](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/restoring) are distinct workflows.
- Dream PR templates were read from the local checkouts at
  `Vivacity-Tech/Dream-Backend/.github/pull_request_template.md` and
  `Vivacity-Tech/Dream-Frontend/.github/pull_request_template.md` on 2026-10-25,
  and naming rules from each repository's `.husky/commit-msg` and `pre-push`;
  read them at the pinned SHA at publish time, not from this summary.
- [Docker security](https://docs.docker.com/engine/security/): daemon privileges and container isolation considerations underlying the separate trusted runner boundary.
