-- Owner-controlled location context for the paired Android companion.
-- The preference is separate from initiative: location is sensitive data and
-- must never become enabled as a side effect of allowing notifications.
CREATE TABLE IF NOT EXISTS athena_location_pref (
  profile_id BIGINT NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  interval_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 900,
  retention_days TINYINT UNSIGNED NOT NULL DEFAULT 2,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id),
  KEY idx_athena_location_pref_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Raw samples are scoped to the paired device that supplied them. They are
-- deliberately not a memory/event: location should not become conversational
-- history, and the service purges samples beyond the person's short retention.
CREATE TABLE IF NOT EXISTS athena_location_sample (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id BIGINT NOT NULL,
  device_id BIGINT UNSIGNED NOT NULL,
  latitude DECIMAL(9,6) NOT NULL,
  longitude DECIMAL(9,6) NOT NULL,
  accuracy_m DECIMAL(8,2) NULL,
  altitude_m DECIMAL(9,2) NULL,
  speed_mps DECIMAL(8,2) NULL,
  bearing_deg DECIMAL(6,2) NULL,
  observed_at DATETIME(3) NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_location_sample (device_id, observed_at),
  KEY idx_athena_location_sample_profile_time (profile_id, observed_at),
  KEY idx_athena_location_sample_device_time (device_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
