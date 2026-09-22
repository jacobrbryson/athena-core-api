-- More than one source now feeds "what is happening near me": the county 911
-- board (PulsePoint) and the National Weather Service. They fail, and are
-- blocked, independently — so health is per source rather than one global row.
-- `hot_until` stays on athena_incident_feed: the rhythm belongs to the
-- situation, not to any one source.
CREATE TABLE IF NOT EXISTS athena_incident_source (
  source VARCHAR(32) NOT NULL,
  last_attempt_at DATETIME NULL,
  last_ok_at DATETIME NULL,
  last_error VARCHAR(500) NULL,
  consecutive_failures INT UNSIGNED NOT NULL DEFAULT 0,
  blocked_at DATETIME NULL,
  outage_notified_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Carry the PulsePoint state over, including the current block, so the
-- back-off and the "already told them" flag survive this migration.
INSERT INTO athena_incident_source (source, last_attempt_at, last_ok_at, last_error, consecutive_failures, blocked_at, outage_notified_at)
SELECT 'pulsepoint', last_attempt_at, last_ok_at, last_error, consecutive_failures, blocked_at, outage_notified_at
FROM athena_incident_feed WHERE id = 1
ON DUPLICATE KEY UPDATE source = source;
INSERT IGNORE INTO athena_incident_source (source) VALUES ('nws');

-- Weather alerts alongside the calls in the assessed situation.
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'athena_incident_situation' AND COLUMN_NAME = 'weather');
SET @ddl := IF(@col = 0, 'ALTER TABLE athena_incident_situation ADD COLUMN weather JSON NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
