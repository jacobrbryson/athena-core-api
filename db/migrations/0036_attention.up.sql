-- Durable, opt-in source interpretation. No grants or initiative preferences.
CREATE TABLE IF NOT EXISTS attention_watch (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  profile_id BIGINT NOT NULL,
  source VARCHAR(64) NOT NULL,
  credential_uuid CHAR(36) NOT NULL,
  external_account_id VARCHAR(190) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  generation CHAR(36) NOT NULL,
  lease_token CHAR(36) NULL,
  lease_until DATETIME(3) NULL,
  sync_state JSON NULL,
  next_sync_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_sync_at DATETIME(3) NULL,
  last_error VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY attention_watch_owner (profile_id, source),
  KEY attention_watch_due (enabled, next_sync_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS attention_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  uuid CHAR(36) NOT NULL,
  watch_id BIGINT UNSIGNED NOT NULL,
  event_key CHAR(64) NOT NULL,
  resource_id VARCHAR(190) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_token CHAR(36) NULL,
  last_error VARCHAR(255) NULL,
  disposition VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  UNIQUE KEY attention_delivery (watch_id, event_key),
  UNIQUE KEY attention_event_uuid (uuid),
  KEY attention_event_due (watch_id, status, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS attention_record (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  uuid CHAR(36) NOT NULL,
  watch_id BIGINT UNSIGNED NOT NULL,
  resource_id VARCHAR(190) NOT NULL,
  observation_hash CHAR(64) NOT NULL,
  context_hash CHAR(64) NOT NULL,
  payload_enc LONGTEXT NOT NULL,
  feedback_enc TEXT NULL,
  feedback_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY attention_record_uuid (uuid),
  KEY attention_record_resource (watch_id, resource_id, id),
  KEY attention_record_feedback (watch_id, feedback_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
