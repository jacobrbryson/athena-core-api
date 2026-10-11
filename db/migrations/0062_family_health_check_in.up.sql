-- =====================================================================
-- 0062_family_health_check_in.up.sql
-- Family health watch: how often Athena should ask for an update on a
-- case (a fever logged hourly, pain medicine every 8 hours), and when the
-- last one came in. NULL check_in_hours means no check-ins — the watch
-- behaves exactly as before. last_update_at is set on every report or
-- update; the family_health_check_in initiative trigger compares the two.
-- =====================================================================

ALTER TABLE family_health_status
  ADD COLUMN check_in_hours SMALLINT UNSIGNED NULL AFTER notes,
  ADD COLUMN last_update_at DATETIME NULL AFTER check_in_hours;

-- Existing active rows: the last thing heard was when they were last saved.
UPDATE family_health_status SET last_update_at = updated_at WHERE last_update_at IS NULL;
