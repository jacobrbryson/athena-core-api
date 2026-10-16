-- Google Nest devices, as last reported by the Smart Device Management API
-- (docs/capabilities/nest.md). One row per profile per device the person
-- shared on Google's Partner Connections screen.
--
-- Kept rather than read live because the thing worth knowing — "it went
-- offline at 2:14" — is a transition, and only a stored previous state can
-- tell a transition from a reading. Pub/Sub push (controllers/nestWebhook.js)
-- moves `connectivity`; the initiative trigger reads it. `event_at` is the
-- provider's timestamp of the newest event applied, so a redelivered or
-- out-of-order message can never move a device backwards.
CREATE TABLE IF NOT EXISTS athena_nest_device (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id BIGINT NOT NULL,
  device_name VARCHAR(255) NOT NULL,
  display_name VARCHAR(120) NULL,
  room VARCHAR(120) NULL,
  device_type VARCHAR(80) NULL,
  connectivity ENUM('ONLINE','OFFLINE','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  offline_since DATETIME(3) NULL,
  online_since DATETIME(3) NULL,
  readings JSON NULL,
  event_at DATETIME(3) NULL,
  synced_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_nest_device (profile_id, device_name),
  KEY idx_nest_device_name (device_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
