-- =====================================================================
-- 0009_guardian_permanent_qr.up.sql
-- Permanent, reusable QR token per guardian.
-- ---------------------------------------------------------------------
-- The single-use guardian_login_token flow (0006) mints a new token —
-- and therefore a new URL — every time, which breaks printed QR codes.
--
-- This migration adds qr_token to guardian_credential: a high-entropy,
-- URL-safe token generated once at seed time and never changed. The /q/
-- redeem route checks this column after the single-use table so that both
-- flows co-exist: printed QR codes use the permanent token; manually
-- issued one-offs (issue-guardian-token.js) stay single-use.
--
-- Only a SHA-256 hash is stored (qr_token_hash) for the same reason as
-- guardian_login_token: the plaintext is encoded into the QR, never
-- persisted. The hash is sufficient for lookup.
-- =====================================================================

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guardian_credential'
    AND COLUMN_NAME = 'qr_token_hash');
SET @ddl := IF(@col = 0,
  'ALTER TABLE guardian_credential
     ADD COLUMN qr_token_hash VARCHAR(64) NULL AFTER city,
     ADD UNIQUE KEY uq_guardian_qr_token_hash (qr_token_hash)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
