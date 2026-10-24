-- =====================================================================
-- 0094_place_fence_status.up.sql
-- Whether each paired phone can hold its place-reminder geofences.
--
-- From 2026-10-08 to 10-24 the owner's phone lost Android's "Allow all the
-- time" location permission and quietly held no fences, so no place reminder
-- could fire and nothing anywhere said so. The phone now reports its state
-- (services/placeReminders.js recordPhoneStatus), and the server notes each
-- fence fetch itself (synced_at) — which also catches an older app that never
-- reports. Athena's prompt and the Community page read it.
--
-- No position is stored here: only a state word, a fence count and when.
-- Conventions match 0001-0093: no enforced FKs.
-- =====================================================================
CREATE TABLE IF NOT EXISTS athena_place_fence_status (
  device_id BIGINT UNSIGNED NOT NULL,
  profile_id BIGINT NOT NULL,
  -- ok | no_background_location | no_location_permission | location_off | register_failed
  state VARCHAR(32) NULL,
  fences SMALLINT UNSIGNED NULL,
  detail VARCHAR(120) NULL,
  reported_at DATETIME NULL,
  synced_at DATETIME NULL,
  PRIMARY KEY (device_id),
  KEY idx_athena_place_fence_status_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
