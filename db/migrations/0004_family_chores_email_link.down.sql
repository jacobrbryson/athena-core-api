-- =====================================================================
-- 0004_family_chores_email_link.down.sql  (reverse of 0004)
-- =====================================================================
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'integration_link'
    AND COLUMN_NAME = 'external_email');
SET @ddl := IF(@col = 1,
  'ALTER TABLE integration_link DROP COLUMN external_email',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Recreate the link-code table (mirrors 0003) so the rollback is faithful.
CREATE TABLE IF NOT EXISTS integration_link_code (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid         CHAR(36)        NOT NULL,
  provider     VARCHAR(40)     NOT NULL DEFAULT 'family_chores',
  code         VARCHAR(120)    NOT NULL,
  profile_id   BIGINT          NOT NULL,
  family_id    BIGINT UNSIGNED NULL,
  expires_at   DATETIME        NULL,
  consumed_at  DATETIME        NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_integration_link_code_uuid (uuid),
  UNIQUE KEY uq_integration_link_code_code (code),
  KEY idx_integration_link_code_profile (profile_id),
  KEY idx_integration_link_code_provider (provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
