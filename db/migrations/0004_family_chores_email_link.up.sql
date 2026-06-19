-- =====================================================================
-- 0004_family_chores_email_link.up.sql
-- Switch the Family Chores integration to an email-based, partner-initiated
-- connect flow.
-- ---------------------------------------------------------------------
-- The original design (0003) used one-time link codes the user pasted into
-- Family Chores. We replaced that with a server-to-server connect: the
-- Family Chores backend posts its API token, Athena reads /me, and matches
-- (or creates) an Athena profile by the owner's email. Two changes:
--   * Drop the now-unused integration_link_code table.
--   * Record the external account email on integration_link.
-- =====================================================================

DROP TABLE IF EXISTS integration_link_code;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'integration_link'
    AND COLUMN_NAME = 'external_email');
SET @ddl := IF(@col = 0,
  'ALTER TABLE integration_link ADD COLUMN external_email VARCHAR(255) NULL AFTER external_family_id',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
