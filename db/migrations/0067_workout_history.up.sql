-- Workout history: one row per provider workout, kept so Athena can look back
-- further than a provider's API lets a conversation page (WHOOP: 25 a read).
-- Written from signed WHOOP webhooks, chat/dashboard reads and the backfill
-- script (scripts/backfillWorkouts.js) — only for an adult whose family has
-- accepted health_data consent. A provider delete marks the row deleted_at;
-- it is not resurrected unless the provider returns it again.
--
-- WHOOP's API carries heart-rate load only: no exercises, sets, reps or weight.
CREATE TABLE IF NOT EXISTS athena_workout (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id BIGINT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  external_id VARCHAR(64) NOT NULL,
  external_account_id VARCHAR(190) NULL,
  sport_name VARCHAR(64) NULL,
  sport_id INT NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NOT NULL,
  timezone_offset VARCHAR(8) NULL,
  score_state VARCHAR(24) NULL,
  strain DECIMAL(7,4) NULL,
  average_heart_rate SMALLINT UNSIGNED NULL,
  max_heart_rate SMALLINT UNSIGNED NULL,
  kilojoules DECIMAL(10,3) NULL,
  -- WHOOP sends a fraction (0.99996) though its docs show 100; holds either.
  percent_recorded DECIMAL(9,6) NULL,
  distance_meter DECIMAL(12,3) NULL,
  altitude_gain_meter DECIMAL(10,3) NULL,
  altitude_change_meter DECIMAL(10,3) NULL,
  -- Milliseconds per heart-rate zone, as the provider reports them.
  zone_durations JSON NULL,
  provider_updated_at DATETIME(3) NULL,
  deleted_at DATETIME(3) NULL,
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_workout (profile_id, provider, external_id),
  KEY idx_athena_workout_profile_time (profile_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
