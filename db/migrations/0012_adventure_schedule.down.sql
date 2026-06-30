UPDATE adventure_state
SET scheduled_end_at = NULL
WHERE adventure_key = 'rescue_ratatouille';

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'adventure_state'
    AND COLUMN_NAME = 'scheduled_start_at');
SET @ddl := IF(@col = 1,
  'ALTER TABLE adventure_state DROP COLUMN scheduled_start_at',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
