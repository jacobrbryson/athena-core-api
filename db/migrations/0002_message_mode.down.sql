-- =====================================================================
-- 0002_message_mode.down.sql  (reverse of 0002_message_mode.up.sql)
-- =====================================================================
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message' AND COLUMN_NAME = 'mode');
SET @ddl := IF(@col = 1, 'ALTER TABLE message DROP COLUMN mode', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
