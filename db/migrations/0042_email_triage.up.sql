-- =====================================================================
-- 0042_email_triage.up.sql
-- Gmail inbox triage: what Athena has sorted out of the inbox, and the
-- structured receipts it extracted along the way.
-- ---------------------------------------------------------------------
-- email_triage is one row per scanned Gmail message (dedup on
-- (profile_id, gmail_message_id) so repeated scans make progress through
-- the backlog instead of re-classifying the same mail). Every scanned
-- message gets a row, even 'other' ones with nothing to propose — the
-- person asked to see everything, not just what Athena picked out.
--
-- email_receipt is written only once a file_receipt_email action is
-- approved and executed (services/actions/registry.js) — never at scan
-- time. It is the table yearly-spend reporting reads.
--
-- Conventions match 0001-0041: BIGINT UNSIGNED ids, no enforced FKs
-- (integrity in the service layer), idempotent CREATE TABLE IF NOT EXISTS.
-- =====================================================================

CREATE TABLE IF NOT EXISTS email_triage (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid              CHAR(36)        NOT NULL,
  profile_id        BIGINT          NOT NULL,
  gmail_message_id  VARCHAR(64)     NOT NULL,
  thread_id         VARCHAR(64)     NULL,
  subject           VARCHAR(500)    NULL,
  from_address      VARCHAR(320)    NULL,
  from_name         VARCHAR(200)    NULL,
  received_at       DATETIME        NULL,
  category          VARCHAR(20)     NOT NULL DEFAULT 'other', -- receipt | travel | school | other
  group_key         VARCHAR(160)    NULL,   -- normalized merchant/sender, for clustering similar receipts
  extracted         TEXT            NULL,   -- JSON: LLM output (receipt fields, or candidate event fields)
  status            VARCHAR(20)     NOT NULL DEFAULT 'new',   -- new | actioned | dismissed
  created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email_triage_uuid (uuid),
  UNIQUE KEY uq_email_triage_message (profile_id, gmail_message_id),
  KEY idx_email_triage_status (profile_id, status),
  KEY idx_email_triage_group (profile_id, group_key),
  KEY idx_email_triage_category (profile_id, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_receipt (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid            CHAR(36)        NOT NULL,
  profile_id      BIGINT          NOT NULL,
  email_triage_id BIGINT UNSIGNED NOT NULL,
  merchant        VARCHAR(200)    NULL,
  category        VARCHAR(60)     NULL,      -- freeform LLM spend category: energy, groceries, dining_out, trash...
  amount          DECIMAL(10,2)   NULL,
  currency        VARCHAR(8)      NULL DEFAULT 'USD',
  purchased_at    DATE            NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email_receipt_uuid (uuid),
  KEY idx_email_receipt_triage (email_triage_id),
  KEY idx_email_receipt_profile_cat_date (profile_id, category, purchased_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
