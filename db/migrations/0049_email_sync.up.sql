-- =====================================================================
-- 0049_email_sync.up.sql
-- Keeps email_triage in step with the Gmail inbox (docs/architecture/mail-card.md,
-- phase 1). One row per profile that uses Mail triage: Gmail's historyId
-- cursor, when the last pass ran, and a short lease so the dashboard and the
-- mail job never run the same pass twice.
--
-- email_triage.status gains two values, no schema change (it is VARCHAR):
--   gone     left the inbox in Gmail (archived, trashed, deleted) before
--            anyone acted on it here; set back to 'new' if it returns
-- and category gains:
--   pending  new mail seen by a sync pass, awaiting classification
-- =====================================================================

CREATE TABLE IF NOT EXISTS email_sync_state (
  profile_id    BIGINT        NOT NULL,
  history_id    VARCHAR(32)   NULL,    -- NULL = never synced, or the cursor expired
  synced_at     DATETIME(3)   NULL,
  reconciled_at DATETIME(3)   NULL,    -- last full check of every open row against the inbox
  lease_until   DATETIME(3)   NULL,
  last_error    VARCHAR(300)  NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
