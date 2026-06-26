-- =====================================================================
-- 0010_guardian_qr_first_used.up.sql
-- Track first use of a guardian's permanent QR token.
-- ---------------------------------------------------------------------
-- After the first QR sign-in, subsequent scans redirect to the manual
-- gate (/:guardian_id) so the player enters their secret. If the device
-- already has a valid session it can be auto-signed in by the frontend.
-- =====================================================================

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guardian_credential'
    AND COLUMN_NAME = 'qr_token_first_used_at');
SET @ddl := IF(@col = 0,
  'ALTER TABLE guardian_credential ADD COLUMN qr_token_first_used_at DATETIME NULL AFTER qr_token_hash',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
