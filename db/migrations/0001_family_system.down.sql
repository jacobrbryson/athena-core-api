-- =====================================================================
-- 0001_family_system.down.sql  (reverse of 0001_family_system.up.sql)
-- WARNING: destroys all family / consent / child-login / memory data.
-- The legacy `profile` and `profile_child` tables are NOT touched.
-- =====================================================================

DROP TABLE IF EXISTS user_memory;
DROP TABLE IF EXISTS child_login_code;
DROP TABLE IF EXISTS family_consent_log;
DROP TABLE IF EXISTS family_consent;
DROP TABLE IF EXISTS family_permissions;
DROP TABLE IF EXISTS child_profiles;
DROP TABLE IF EXISTS family_members;
DROP TABLE IF EXISTS families;
DROP TABLE IF EXISTS conversation_mode;

-- Drop additive session columns if present.
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session' AND COLUMN_NAME = 'mode');
SET @ddl := IF(@col = 1, 'ALTER TABLE session DROP COLUMN mode', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session' AND COLUMN_NAME = 'family_id');
SET @ddl := IF(@col = 1, 'ALTER TABLE session DROP COLUMN family_id', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session' AND COLUMN_NAME = 'profile_id');
SET @ddl := IF(@col = 1, 'ALTER TABLE session DROP COLUMN profile_id', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
