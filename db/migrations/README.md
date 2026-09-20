# Database migrations

Forward-only SQL migrations applied by [`../migrate.js`](../migrate.js).

## Running

```bash
# from core_api/
node db/migrate.js           # apply all pending *.up.sql
node db/migrate.js status     # show applied vs pending
node db/migrate.js down 0001_family_system   # manual rollback of one migration
```

Connection is read from the same env vars as the app (`DB_HOST`, `DB_USER`,
`DB_PASS`, `DB_NAME`, `DB_PORT`). Applied migrations are tracked in the
`schema_migrations` table, so re-running is safe.

## Conventions

- One logical change per numbered pair: `NNNN_name.up.sql` / `NNNN_name.down.sql`.
- New tables use `BIGINT UNSIGNED` auto-increment ids and `utf8mb4`.
- Columns that reference the legacy `profile.id` are plain `BIGINT` with an
  index but **no enforced FK**, matching the existing codebase convention
  (referential integrity is maintained in the service layer). Foreign keys
  are enforced only between the new family-system tables.
- `*.up.sql` files should be idempotent where practical (guarded `ALTER`s,
  `INSERT ... ON DUPLICATE KEY`, `NOT EXISTS` back-fills) so partial
  re-application during development is non-destructive.

## Migrations

| id | summary |
|----|---------|
| `0001_family_system` | Families, members, child profiles, permissions, consent (+ audit log), child login codes, conversation-mode catalog, user_memory, and additive `session.profile_id / family_id / mode` columns. Back-fills families from existing `profile_child` links. |
| `0002_message_mode` | Additive `message.mode` column so each message records the conversation mode it was exchanged under. |
| `0003_family_chores_integration` | External-app integration tables powering the Family Chores link. Partner API tokens are encrypted at rest. See [`docs/architecture/family-chores-integration.md`](../../../docs/architecture/family-chores-integration.md). |
| `0004_family_chores_email_link` | Switches Family Chores to a partner-initiated, email-based connect: drops the unused `integration_link_code` table and adds `integration_link.external_email`. |
| `0005_guardian_credentials` | Guardian auth tables: `guardian_credential` (hashed ID+secret), `guardian_login_attempt` (audit log). |
| `0006_guardian_login_token` | Single-use QR login tokens (`guardian_login_token`). Only the SHA-256 hash of the token is stored; the plaintext is issued once and encoded into the QR code. |
| `0007_guardian_player_profile` | Adds `email` and `city` columns to `guardian_credential`. Adds `guardian_adventure` join table so a player can be enrolled in multiple adventures. Back-fills existing credentials into `guardian_adventure`. |
| `0008_adventure_state` | Per-adventure lifecycle table (`adventure_state`). `lake_norman_guardians` is seeded as `active`; `rescue_ratatouille` starts as `pending` and is activated atomically by the first enrolled player who signs in. |
| `0009_guardian_permanent_qr` | Adds `qr_token_hash` to `guardian_credential`. Permanent, reusable QR tokens whose plaintext never changes — safe to print on physical cards. The `/q/` route checks this after the single-use token table so both flows co-exist. |
| `0012_adventure_schedule` | Adds campaign start scheduling and configures Rescue Ratatouille for July 6–12, 2026 (America/New_York). |
| `0014_guardian_trail_key` | Rescue Ratatouille Mission 1 key-use table (`guardian_trail_key`): per-guardian single-use decryption keys, order-of-use clue indices, pending→used two-step. Reset with `npm run reset:trail [guardian_id]` (trail only) or `npm run reset:experience [guardian_id]` (trail + first-login + QR first-use, for replaying the whole first-contact experience). |
| `0017_move_all_guardians_to_first_watch` | Makes Lake Norman / Mission 3 the primary campaign for every active Guardian while retaining Rescue Ratatouille as historical secondary enrollment. |
| `0018_guardian_index_clue` | Adds resumable Mission 3 clue-decryption assignments, revalidated before reveal so hints always target unfound cards. |
| `0024_user_credential` | Per-user credentials for third-party integrations (Google Calendar, Strava, Whoop, a user-supplied API key): `user_credential` plus an append-only `user_credential_audit`. Access and refresh tokens are encrypted at rest under the rotating keyring — both columns are registered in `ENCRYPTED_COLUMNS` in [`../../src/jobs/rotate-keys.js`](../../src/jobs/rotate-keys.js). See [`docs/architecture/secret-rotation.md`](../../../docs/architecture/secret-rotation.md). |
| `0025_oauth_state` | Short-lived, single-use state for outbound OAuth flows (`oauth_state`). The provider redirects a browser with no Athena JWT, so `state` is the credential carrying identity across the round trip: stored as sha256, consumed exactly once by a guarded UPDATE, expires in minutes. See [`docs/architecture/integrations-oauth.md`](../../../docs/architecture/integrations-oauth.md). |
| `0026_athena_action` | Athena's action layer: `athena_action` (one row per proposal, carrying both what she proposed and what happened) and `athena_action_authority` (standing approvals). Status is the concurrency control, not a label — the `pending` → `executing` transition is a guarded UPDATE, which is what makes a double-tapped Approve execute exactly once. No path leads from a terminal status back to `pending`. See [`docs/architecture/action-layer.md`](../../../docs/architecture/action-layer.md). |
| `0027_athena_initiative` | Athena speaking first: `athena_nudge` (one row per thing she raised, carrying both the deterministic `facts` that triggered it and the model's wording), plus per-person `athena_initiative_pref` and `athena_trigger_mute`. The unique key over (profile, trigger, dedupe_key) is the interruption budget's hard floor — one nudge per occurrence, ever — and is what makes the evaluator safe to run from several places at once. See [`docs/architecture/initiative.md`](../../../docs/architecture/initiative.md). |
| `0028_device_push` | Push registrations on `paired_device` (`push_token_enc` encrypted under the rotating keyring and registered in `ENCRYPTED_COLUMNS`), `athena_nudge.pushed_at`, and `athena_initiative_pref.push_enabled`. The registration lives on the device row so revoking a device revokes its ability to buzz you by construction. See [`docs/architecture/push-notifications.md`](../../../docs/architecture/push-notifications.md). |
| `0029_trigger_score` | What Athena has learned about which interruptions were wanted: `athena_trigger_score` (EWMA in [0,1] per profile+trigger, with her own `suppressed_at`) plus `athena_nudge.appraisal`. The score may only ever make her quieter — it redistributes a fixed interruption budget between triggers and can suppress one, but never raises a cap, shortens spacing or lifts a mute. Her suppression is deliberately a different thing from the person's `athena_trigger_mute`. |
| `0035_location_context` | Explicit location-sharing preference plus short-retention, per-device location samples for owner-approved context. |

See [`docs/architecture/family-system.md`](../../../docs/architecture/family-system.md)
for the data-model rationale and the deprecation path for `profile_child`.

---

## Guardian campaigns

The Guardian adventures (Lake Norman Guardians, Rescue Ratatouille) are managed
through three tables: `guardian_credential`, `guardian_adventure`, and
`adventure_state`.  The seed script and SQL snippets below cover the common
operational tasks.

### Resetting everything (full campaign reset)

Clears login history so everyone gets the first-contact greeting again, resets
rescue_ratatouille to pending, and prints the full credential table. QR code
URLs are permanent — they do not change on reset, so printed cards stay valid.

```bash
node db/reset-campaign.js --base https://your-domain.com
```

Preview what will change without writing anything:

```bash
node db/reset-campaign.js --dry-run
```

### How permanent QR tokens work

On the **first** run of `seed-lake-norman-2025.js`, a high-entropy permanent
token is generated for each player, its SHA-256 hash is stored in
`guardian_credential.qr_token_hash`, and the plaintext is written back into
`guardians.lake-norman-2025.json` as `qr_token`. That file is the source of
truth for the URL — guard it like a credential file.

On every subsequent seed or reset, the existing token is reused verbatim,
so the `/q/<token>` URL printed into a QR code never changes.

The `/q/` route checks single-use tokens first (issued by `issue-guardian-token.js`
for one-off links), then falls back to the permanent token. Both flows co-exist.

---

### Seeding / re-seeding players

The seed script is idempotent — re-running it updates credentials in place and
mints fresh QR tokens without touching existing ones.

```bash
# from core_api/
node db/seed-lake-norman-2025.js --base https://your-domain.com --ttl-hours 720
```

### Issuing a replacement QR token for one player

Useful when a child's QR code is lost or a token has expired.

```bash
node db/issue-guardian-token.js 20250201 --base https://your-domain.com --ttl-hours 720
#                               ^^^^^^^^ guardian_id
```

### Resetting a campaign (adventure_state)

Resetting an adventure puts it back to `pending` so it will be re-triggered the
next time an enrolled player signs in.

```sql
-- Reset rescue_ratatouille to pending (clears trigger record).
UPDATE adventure_state
SET state                  = 'pending',
    activated_at           = NULL,
    activated_by_guardian_id = NULL,
    ended_at               = NULL
WHERE adventure_key = 'rescue_ratatouille';
```

To mark a campaign as **ended** (players are no longer routed into it even if
enrolled):

```sql
UPDATE adventure_state
SET state    = 'ended',
    ended_at = NOW()
WHERE adventure_key = 'rescue_ratatouille';
```

To **manually activate** a campaign without waiting for a player sign-in:

```sql
UPDATE adventure_state
SET state        = 'active',
    activated_at = NOW(),
    activated_by_guardian_id = NULL   -- or a real guardian_id if known
WHERE adventure_key = 'rescue_ratatouille';
```

To set a campaign schedule (stored in UTC; the end is exclusive):

```sql
UPDATE adventure_state
SET scheduled_start_at = '2026-07-06 04:00:00',
    scheduled_end_at   = '2026-07-13 04:00:00'
WHERE adventure_key = 'rescue_ratatouille';
```

### Re-issuing all QR tokens after a reset

After resetting the campaign you may want fresh tokens for all enrolled players.
Re-run the seed script (see above) — it mints new tokens without invalidating
the old ones. To explicitly revoke all unused tokens for a player first:

```sql
-- Expire all unused tokens for a specific guardian.
UPDATE guardian_login_token lt
JOIN  guardian_credential   gc ON gc.id = lt.credential_id
SET   lt.expires_at = NOW()
WHERE gc.guardian_id = '20250201'
  AND lt.used_at IS NULL;
```

### Removing a player

Soft-deactivate so login is refused but the row and its history are kept:

```sql
UPDATE guardian_credential SET is_active = 0 WHERE guardian_id = '20250201';
```

To re-activate:

```sql
UPDATE guardian_credential SET is_active = 1 WHERE guardian_id = '20250201';
```
