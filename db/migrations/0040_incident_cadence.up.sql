-- The watcher's own rhythm (owner, 2026-09-22): every 15 minutes normally,
-- every 5 for an hour once something comes up near a watched place, and a
-- source that has shut automated readers out is asked again only rarely.
-- The scheduler fires every 5 minutes; these columns decide whether a tick
-- actually reads anything.
--
-- Guarded (MySQL 8 has no ADD COLUMN IF NOT EXISTS), same pattern as 0002.
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'athena_incident_feed' AND COLUMN_NAME = 'hot_until');
SET @ddl := IF(@col = 0,
  'ALTER TABLE athena_incident_feed ADD COLUMN last_attempt_at DATETIME NULL, ADD COLUMN hot_until DATETIME NULL, ADD COLUMN blocked_at DATETIME NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
