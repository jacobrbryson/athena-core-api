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

See [`docs/architecture/family-system.md`](../../../docs/architecture/family-system.md)
for the data-model rationale and the deprecation path for `profile_child`.
