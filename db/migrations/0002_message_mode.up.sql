-- =====================================================================
-- 0002_message_mode.up.sql
-- Per-message conversation mode for auditing.
-- ---------------------------------------------------------------------
-- A session's `mode` is mutable (a user may switch between Learning and
-- Companion mode within one session), so session.mode alone cannot tell
-- an auditor which mode a given message was exchanged under. Record the
-- active mode on each message row at insert time so companion-mode
-- communication is unambiguously attributable.
--
-- Guarded so re-running does not error on an already-added column.
-- =====================================================================
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message' AND COLUMN_NAME = 'mode');
SET @ddl := IF(@col = 0,
  'ALTER TABLE message ADD COLUMN mode VARCHAR(40) NULL, ADD KEY idx_message_mode (mode)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
