-- =====================================================================
-- 0080_weather_alerts.up.sql
-- Weather alerts the person sets for themselves (owner, 2026-10-18: "it's
-- almost time for our first frost ... the ability to setup alerts for
-- temperatures or weather events"). One row per rule: "tell me when it's
-- going to drop to 34°F at Home", "rain over 60% at the farm", "wind over
-- 35 mph". Read against the NWS hourly forecast by the athena-incidents job;
-- see src/services/weatherAlerts.js and docs/capabilities/weather-alerts.md.
--
-- athena_weather_alert_fire is one row per (rule, occurrence) — a cold
-- night, a rainy day — and its unique key is the dedupe: a rule tells about
-- the same night once, however many times the forecast is re-read. A row is
-- written only when the alert is actually sent; an alert held for the night
-- writes nothing and goes out in the morning.
--
-- Conventions match 0001-0079: no enforced FKs, place_uuid is a soft link to
-- athena_watch_place (NULL = home).
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_weather_alert (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid            CHAR(36)        NOT NULL,
  profile_id      BIGINT          NOT NULL,
  kind            VARCHAR(16)     NOT NULL,  -- cold | heat | rain | snow | ice | storm | wind
  threshold       SMALLINT        NULL,      -- °F for cold/heat, % for rain, mph for wind
  place_uuid      CHAR(36)        NULL,      -- athena_watch_place.uuid; NULL = home
  lead_hours      TINYINT UNSIGNED NOT NULL DEFAULT 24,
  note            VARCHAR(200)    NULL,      -- "cover the tomatoes", said with the alert
  enabled         TINYINT(1)      NOT NULL DEFAULT 1,
  last_checked_at DATETIME        NULL,
  last_error      VARCHAR(190)    NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_weather_alert_uuid (uuid),
  KEY idx_athena_weather_alert_profile (profile_id),
  KEY idx_athena_weather_alert_due (enabled, last_checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_weather_alert_fire (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  alert_id    BIGINT UNSIGNED NOT NULL,
  occurrence  VARCHAR(32)     NOT NULL,      -- the local date (a night's evening for cold)
  value       SMALLINT        NULL,          -- the low, the high, the chance, the wind
  weather_at  DATETIME        NULL,          -- when that value is forecast
  text        VARCHAR(500)    NOT NULL,
  nudge_uuid  CHAR(36)        NULL,
  pushed      TINYINT(1)      NOT NULL DEFAULT 0,
  fired_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_weather_alert_fire (alert_id, occurrence),
  KEY idx_athena_weather_alert_fire_recent (alert_id, fired_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
