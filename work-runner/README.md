# Local client work runner

This package runs approved client work on the owner's computer. It does not use
Athena's self-repair GitHub token or its repository allowlist. The core API owns
Jira writes, model keys, approvals and usage; no company provider key is delivered
to this runner. Your Docker daemon remains a trusted owner-controlled service.

## Prerequisites

- Node 22 or later and a running Docker Desktop Linux engine.
- Deploy the core/Companion changes and apply only `0099_work_items`:
  `node db/migrate.js up 0099_work_items` from core_api. Check the migration runner's
  usage before running; do not apply somebody else's pending migrations.
- Configure `WORK_ARTIFACT_BUCKET` on core_api with a private bucket. Its runtime
  identity needs object create/read access there and read access to the selected
  backup object under `gs://dream-db-exports/sterilized/`. These are new deployment
  configuration requirements; this implementation does not grant IAM or deploy.
- Set owner-controlled `WORK_BACKUP_PREFIXES` to bind allowed GCS prefixes to
  the owning profile and workplace. For the reviewed Vivacity record:

  ```json
  {"97b00cbf-26a6-45af-85a2-a69252c7be3a":{"profileId":1,"prefixes":["gs://dream-db-exports/sterilized/"]}}
  ```

- For a signed-in demo, set owner-controlled `WORK_AUTH_DOMAINS` the same way,
  naming the client's **test** sign-in tenant (never production). It is the
  sandbox's only outside destination, and only while a demo records:

  ```json
  {"97b00cbf-26a6-45af-85a2-a69252c7be3a":{"profileId":1,"domains":["<test-tenant>.us.auth0.com"]}}
  ```

  The proxy also allows Auth0's fixed login-page asset hosts (`cdn.auth0.com`
  and its regional variants). Save the minimal-role test login under **Demo test
  login** in setup; the runner fetches it only while recording and the browser
  tool types it itself. It never reaches the model, the evidence or the logs.
  The test user must exist, with that role, in the restored backup, and the
  tenant's SPA application must allow `http://localhost:8081` as a callback.

  Other users/workplaces cannot read that prefix through the runtime's shared
  GCP identity merely by entering a bucket name in their environment. Missing
  configuration fails closed, independently of GCP IAM and user approval.
- Keep the existing incidents job running: it releases held work notifications
  after quiet hours even if the local runner is offline.
- Company-owned GitHub read and OpenAI or Anthropic API credentials; Jira Add
  comments permission for the issue. Existing Jira OAuth connections need an
  explicitly consented write scope before comments can work. The first Dream
  connection is an API token, whose project permissions must still be verified.
- Enough disk for the uncompressed database plus checkout, dependencies and
  recordings. This first version accepts logical backups up to 20 GiB, PostgreSQL
  17, and public npm dependencies. Other runtime/dependency types need an explicit
  implementation extension. Never point test applications at production services.

## Build and pair

From this directory:

```powershell
npm.cmd run build:image
$env:ATHENA_WORK_API = 'https://YOUR-PROXY-HOST/api/v1'
node runner.mjs --pair XXXX-XXXX
node runner.mjs
```

Use the actual trusted proxy hostname configured for Companion. For development
against core_api directly, use `http://localhost:PORT` without `/api/v1`. Do not
send a pairing code or saved device token to another host. Pair through **Work →
Development environments & keys → Create pairing code**. After redemption, click
**Refresh setup** in Companion before filling the runner ID.

The token is saved in `.runner-token.json` (excluded from Git and image context).
On Windows, store this checkout under your private user directory with its normal
user-only access controls; the POSIX file mode is not a Windows ACL. Revoke Work
runner under the existing Phone & car/device settings to disconnect it. It has
the authority of a paired owner device: use only an owner-controlled computer.

## Configure the first environment

In Work setup, select Vivacity, save the company keys and choose **Fill linked
credential and runner IDs**. Confirm the provider and exact model ID, token
ceiling, branch names and development commands. The preset repository URLs are:

- `https://github.com/Vivacity-Tech/Dream-Frontend`
- `https://github.com/Vivacity-Tech/Dream-Backend`

Replace the backup prefix with an exact sterilized object and select `sql`,
`sql.gz` or `custom` (a pg_dump custom-format archive). Do not use a managed Cloud
SQL backup directly. Configure FE/BE health URLs using their private service
names, e.g. `http://frontend:3000/` and `http://backend:3001/health`.

Every repository needs one start recipe and at least one test recipe overall.
Commands run in their own repository directory. Bind development servers on
`0.0.0.0`. Containers receive `DATABASE_URL` for the isolated database, plus the
toolbox receives PG connection variables; extra real application configuration
and third-party services are not yet supported. Don't paste keys or production
environment files into recipes. The preset commands are examples, not verified
Dream instructions. Use the optional Jira `customfield_...` acceptance field if
the ticket stores criteria separately from its description.

Save a revision, open DRM-9902, select that environment, click **Plan**, inspect
the snapshot/recipes, then confirm. The runner restores data and must pass
health/baseline tests before asking a company model to investigate. The model
gets source-file operations and configured test IDs, not a shell or credentials.
Every request is checked against a live device, owner grant, approved parent
action and lease. Core-funded voice is available only during the demo phase.

Approve the resulting plan from the drawer. The exact plan is posted to Jira
before local product edits. The implementation uses the retained checkout and
database. Browser steps use exact labels and real visible-text assertions. Review
the patch and evidence yourself; unsupported/unlisted criteria are not certified.
No branch, PR, merge or deployment is performed.

Browser notifications deep-link to the run. The existing Android notification
renderer may open the app's default screen instead; the ready run remains under
Work. Native APK deep-link updates are not part of this implementation.

## Database checks for PR reviews

A PR review with `.sql` files can try them on a disposable database. This needs
only Docker, this runner and a backup file. It doesn't need a Work environment,
`WORK_ARTIFACT_BUCKET` or `WORK_BACKUP_PREFIXES`, and the backup stays here.

Put the backup in a folder named for the GitHub owner, in lowercase. The newest
file is used, and a `.sql`, `.sql.gz` or pg_dump custom archive all work:

```text
%USERPROFILE%\.athena-work\db-backups\vivacity-tech\sterilized.sql.gz
```

Set `ATHENA_DB_BACKUPS` to use a different root. It's outside this repository on
purpose, so company data can't be committed or built into an image. The runner
polls while idle; a Work Item run takes priority, and a review that waits more
than eight minutes goes ahead without the check.

Each check runs `postgres:17` with `--network none`, 2 GB of memory and no host
mounts, then removes the container and its data. PR SQL runs as superuser inside
that container, so assume it can do anything there and nothing outside it.

## Isolation and recovery

Only the trusted daemon controls Docker. Application/agent containers run as a
non-root user without host mounts, privileged mode, Docker socket or NET_ADMIN.
A trusted one-shot firewall helper receives NET_ADMIN only inside the target
container's network namespace. Its OUTPUT rules permit job peers and loopback,
and block the Docker host/gateway and external/metadata destinations. During
installation, an allowlisted CONNECT proxy permits registry.npmjs.org; it stops
before runtime/model work. The runner blocks if firewall installation fails.
Private npm registries, GitHub package downloads and external auth are intentionally
not enabled in this first version. Test this boundary before introducing client data.

The runner stops containers after planning and implementation, retaining their
filesystem/volumes. Approval restarts the same environment. If a lease expires,
the run blocks; it does not replay ambiguous writes. A Jira timeout causes
reconciliation for the exact run/plan marker, never a blind duplicate comment.
A model timeout retains a usage reservation as unknown and blocks further work.

Stop cancels server authority immediately; the runner's heartbeat stops local
containers within about 30 seconds. A network outage also stops them when the
heartbeat fails. If the runner process itself is killed, manually stop retained
containers until it can reconnect. Do not leave a stopped run's services running.

Resources are named `athena-work-RUN_UUID-*`. Inspect the exact run's containers,
networks and volumes before deleting them; never use broad Docker prune commands
to clean a run. Retained source, database, logs and recordings can contain client
data. Delete the exact run's stopped containers and networks, then its source
and PostgreSQL anonymous volumes when review is finished. Private uploaded
artifacts follow your configured storage lifecycle; application deletion/TTL
management is not implemented yet.

## Verification

```powershell
node --test tests/operations.test.mjs
node tests/docker-smoke.mjs
node tests/mysql-smoke.mjs
node --test tests/db-check.test.mjs
node tests/db-check-smoke.mjs
```

From core_api run the work-items, actions, credentials, model adapters and
selfKnowledge suites. A successful unit/build check is not an end-to-end Dream
test: that requires the company key, repository access, backup, exact commands
and test login. Never report DRM-9902 or its acceptance criteria as verified
until that run actually completes.

Implementation verification on 2026-10-25: Companion production build/typecheck
and 16 work-status tests passed; 233 backend assertions passed across work-items,
actions, credentials, provider adapters, Jira, workplaces, accounting metadata
and capability catalog suites. The isolated Docker fixture checked non-root
execution, immutable tools, output firewall rules, private service DNS, real
button interaction/assertion, recording and MP4 encoding. Migration creation,
leased-row update, JSON reads and rollback passed on isolated MySQL 8.4.
The host skipped the symlink-creation fixture because Windows denied creation;
path/secret/traversal checks passed.

The unchanged standalone `src/security/access.node.cjs` suite has one failing
HTTP expectation for `/integrations/family-chores/suggest-chores`: it expects
403 while the existing middleware forwards that partner route to its own
authorization controller. Ten other assertions in that suite passed. Neither
the middleware nor that protected test was changed. The aggregate Jest run also
retains existing background handles after reporting passing assertions; run
the focused new suites normally or use the existing CI process-exit convention.
This is not a completed real Dream acceptance run or production deployment.
