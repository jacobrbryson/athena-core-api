-- Schedule Rescue Ratatouille for July 6-12, 2026 in America/New_York.
-- Times are UTC. The end is exclusive, so all of July 12 EDT is included.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'adventure_state'
    AND COLUMN_NAME = 'scheduled_start_at');
SET @ddl := IF(@col = 0,
  'ALTER TABLE adventure_state ADD COLUMN scheduled_start_at DATETIME NULL AFTER activated_by_guardian_id',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE adventure_state
SET state                    = 'pending',
    scheduled_start_at       = '2026-07-06 04:00:00',
    scheduled_end_at         = '2026-07-13 04:00:00',
    activated_at             = NULL,
    activated_by_guardian_id = NULL,
    ended_at                 = NULL
WHERE adventure_key = 'rescue_ratatouille';
