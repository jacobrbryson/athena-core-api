ALTER TABLE athena_place_reminder
  DROP KEY idx_athena_place_reminder_expiry,
  DROP COLUMN expiry_asked_at,
  DROP COLUMN expires_at,
  DROP COLUMN condition_met_at,
  DROP COLUMN after_at,
  DROP COLUMN after_longitude,
  DROP COLUMN after_latitude,
  DROP COLUMN after_label,
  DROP COLUMN after_kind;
DROP TABLE IF EXISTS athena_time_reminder;
