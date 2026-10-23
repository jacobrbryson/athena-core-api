-- Google Nest reading history (docs/capabilities/nest.md, sleep-climate.md).
-- athena_nest_device keeps only the last-known state; questions over time —
-- "how warm was the bedroom while I slept", "is the heat keeping up" — need
-- the readings themselves. Written by services/nestHistory.js from the same
-- two paths that move the device row (Pub/Sub push and sync): at most one row
-- per device per ten minutes, plus every change of hvac, mode or setpoint so
-- a heating run's start and end are exact. Placeholder readings from a
-- thermostat that is not reporting are never written. Pruned at 120 days.
CREATE TABLE IF NOT EXISTS athena_nest_reading (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id BIGINT NOT NULL,
  device_name VARCHAR(255) NOT NULL,
  at DATETIME(3) NOT NULL,
  temperature_c DECIMAL(5,2) NULL,
  humidity TINYINT UNSIGNED NULL,
  hvac ENUM('HEATING','COOLING','OFF') NULL,
  mode VARCHAR(16) NULL,
  heat_c DECIMAL(5,2) NULL,
  cool_c DECIMAL(5,2) NULL,
  eco VARCHAR(16) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_nest_reading (profile_id, device_name, at),
  KEY idx_nest_reading_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The thermostat a person sleeps near, when its name doesn't say "bedroom".
ALTER TABLE athena_nest_device
  ADD COLUMN sleep_device TINYINT(1) NOT NULL DEFAULT 0 AFTER readings;
