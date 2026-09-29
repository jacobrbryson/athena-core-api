-- Live heart rate from a chest strap / WHOOP "Heart Rate Broadcast", read by
-- the paired Android phone over Bluetooth (HeartRateService.java).
--
-- Separate from location and initiative: heart rate is health data and must
-- never be switched on as a side effect of another setting. No row = off.
CREATE TABLE IF NOT EXISTS athena_heart_pref (
  profile_id BIGINT NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  retention_days TINYINT UNSIGNED NOT NULL DEFAULT 30,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per minute per phone: a summary, never individual beats. The phone
-- keeps readings in memory only for the minute it is summarising. Purged past the
-- pref's retention on every upload, and entirely when the pref is turned off.
CREATE TABLE IF NOT EXISTS athena_heart_minute (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id BIGINT NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  minute_at DATETIME NOT NULL,
  bpm_min SMALLINT UNSIGNED NOT NULL,
  bpm_avg SMALLINT UNSIGNED NOT NULL,
  bpm_max SMALLINT UNSIGNED NOT NULL,
  -- How many readings the band sent in the minute (about one a second).
  readings SMALLINT UNSIGNED NOT NULL,
  source VARCHAR(32) NOT NULL,
  -- 'ride' | 'run' while an exercise session with limits was running, else NULL.
  session_sport VARCHAR(16) NULL,
  -- 'above' | 'below' when a limit was crossed in this minute (the phone spoke).
  limit_crossed VARCHAR(8) NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_heart_minute (device_id, minute_at),
  KEY idx_athena_heart_minute_profile_time (profile_id, minute_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
