# Work items implementation checkpoint — 2026-10-25

The first implementation is present locally in core_api, Companion and the
self-contained `core_api/work-runner` package. It has not been deployed or
migrated against the configured hosted database, and no real Dream issue has
been processed. The original design is in `work-item-sandbox-plan.md`.

## Implemented path

- Work preview and detail Jira rows open a shared wide sidebar; issue-by-URL
  entry supports tickets outside the assigned-sprint summary. Description,
  paginated comments, attachment metadata and configured acceptance criteria are
  read through the existing user's API-token or unambiguous OAuth account.
- Setup saves immutable multi-repository environment revisions, encrypted
  workplace-specific GitHub/OpenAI/Anthropic keys, runner binding, PostgreSQL 17
  backup object/format, explicit recipes, health URLs, model and token ceiling.
  The initial configuration editor uses a Dream preset that still needs actual
  branches, object and commands confirmed.
- The planning and implementation actions go through the existing recorded
  propose/confirm/audit gates and never allow standing approval. The normalizers
  and dispatch recheck ownership, workplace credentials and immutable inputs.
  Implementation rejects a changed Jira snapshot and reconciles ambiguous
  comment publication instead of blindly retrying it.
- A paired local runner polls and leases only its own approved jobs. Preparation
  fetches pinned source archives through the broker, streams the sterilized
  backup into PostgreSQL 17, builds, starts services and checks baseline tests.
  No company key is delivered to the Docker processes.
- A guarded company-model loop proposes bounded list/search/read/edit/write,
  configured test and browser operations. Planning cannot edit product files.
  The runner is non-root; its trusted tools are root-owned and read-only.
  An isolated network namespace firewall permits job peers and blocks the host,
  external services and metadata. An npm-only package broker closes before
  runtime/model operations.
- Per-call intent, usage, payer and reservations persist. Unknown usage stops
  the run. Ticket inference has no global-key fallback. Core-funded voice is
  available only in the approved evidence phase. Job state persists independently
  of push; quiet hours defer notifications and distinct events have unique keys.
- Implementation produces a patch, configured test results, browser assertions,
  recorded video and core-funded Athena narration. Evidence and patch/video
  downloads are authenticated and stored privately. Final acceptance remains
  human; unsupported/unlisted criteria are not certified.

## Checks completed

- 233 passing assertions across 11 backend suites: new work-items/engine/provider
  tests plus existing actions, credentials, Jira, workplaces, accounting metadata,
  OpenAI compatibility and self-knowledge.
- Companion production build, typecheck and 16 existing work-status tests passed.
- Browser fixture verified Jira-row → sidebar → environment → approval → plan
  review. Canned preview data was clearly labeled and no provider calls occurred.
- Actual Docker runtime smoke checked non-root execution, immutable tools,
  firewall installation and blocked external/host-gateway access, private DNS,
  button interaction, real text assertion, browser video and MP4 encoding.
- Migration 0099 table creation, JSON configuration, leased-row transition and
  down migration passed in a disposable MySQL 8.4 container with no network.
- Source/secret/traversal file-operation checks passed. The host symlink-creation
  fixture was skipped because Windows refused symlink creation.

The unchanged standalone access test has one older HTTP expectation failure for
the Family Chores partner suggestion route: it expects rejection in the boundary,
where current middleware intentionally forwards to the partner authorization
controller. Ten other checks there passed. Neither protected file was modified.
The aggregate Jest process retains background handles after reporting its passing
assertions; the focused new suites exit normally. Test cleanup stopped that
specific test process. Do not describe the whole security suite as passing.

## Before a real DRM-9902 run

1. Review/deploy core_api and Companion changes and apply only migration 0099.
2. Configure a private `WORK_ARTIFACT_BUCKET`, runtime GCS object permissions,
   and the owner-only `WORK_BACKUP_PREFIXES` workplace/profile binding (plus
   `WORK_AUTH_DOMAINS` for a signed-in demo against the test tenant). See
   `../../work-runner/README.md` for exact setup and local runner commands.
3. Pair the local runner and enter company keys through the protected setup UI.
4. Confirm branch names, exact logical export object/format/extensions, real
   build/start/test commands and an achievable browser scenario/test login.

The metadata-only GCS check using the currently active Orcwood account returned
403. No Vivacity Google account was present in the local signed-in account list.
No database backup was downloaded and no IAM grants or account settings changed.

Initial limitations remain explicit: Node/PostgreSQL 17 recipes, public npm only,
no arbitrary external services or OAuth browser login, no automatic replay after
lease loss, no plan editing in place, no PR/publishing/merge/deploy, no artifact
deletion UI or dollar invoice export. Retained local volumes need explicit cleanup.
Android notices arrive through the existing renderer but may open the default
screen; browser notices deep-link directly. This checkpoint is not a claim that
the Dream environment or all acceptance criteria have been verified.
