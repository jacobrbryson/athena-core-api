-- =====================================================================
-- 0007_guardian_player_profile.up.sql
-- Add player-profile fields to guardian_credential and introduce a
-- guardian_adventure join table for players enrolled in multiple games.
-- ---------------------------------------------------------------------
-- Changes:
--   * guardian_credential gains `email` and `city` columns so Athena
--     can personalise responses and cross-reference learning-app memories.
--   * guardian_adventure (new) normalises the many-to-many relationship
--     between a guardian and the adventures they are enrolled in.
--     adventure_key on guardian_credential remains as the *primary* adventure
--     (determines initial session mode on login) and is kept for backward
--     compatibility with existing auth routes.
-- =====================================================================

-- guardian_credential.email
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guardian_credential'
    AND COLUMN_NAME = 'email');
SET @ddl := IF(@col = 0,
  'ALTER TABLE guardian_credential ADD COLUMN email VARCHAR(255) NULL AFTER display_name',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- guardian_credential.city
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guardian_credential'
    AND COLUMN_NAME = 'city');
SET @ddl := IF(@col = 0,
  'ALTER TABLE guardian_credential ADD COLUMN city VARCHAR(120) NULL AFTER email',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- guardian_adventure  (many-to-many: one guardian, many adventure keys)
CREATE TABLE IF NOT EXISTS guardian_adventure (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guardian_id   VARCHAR(8)      NOT NULL,  -- -> guardian_credential.guardian_id
  adventure_key VARCHAR(60)     NOT NULL,
  is_primary    TINYINT(1)      NOT NULL DEFAULT 0,
  enrolled_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_guardian_adventure (guardian_id, adventure_key),
  KEY idx_guardian_adventure_key (adventure_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Back-fill guardian_adventure from existing guardian_credential rows
-- so the join table stays in sync with any credentials seeded before this migration.
INSERT INTO guardian_adventure (guardian_id, adventure_key, is_primary)
SELECT guardian_id, adventure_key, 1
FROM guardian_credential
ON DUPLICATE KEY UPDATE is_primary = VALUES(is_primary);
