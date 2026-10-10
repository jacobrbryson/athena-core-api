-- =====================================================================
-- 0059_reminder_conditions.up.sql
-- Reminders with a time, and reminders with a condition.
--
-- athena_time_reminder: "remind me at 7 to ..." — fired by the
-- athena-reminders job (src/jobs/reminders.js), once a minute.
--
-- athena_place_reminder gains an optional condition that must happen first
-- ("when I get home FROM THE GYM"): a place visited (after_kind 'place', a
-- second geofence that reports only "was there"), or a time passed
-- (after_kind 'time' — a set time, or when a calendar event ends). A
-- reminder with a condition starts 'waiting', becomes 'armed' once the
-- condition is met, and if expires_at passes first it becomes 'expired' and
-- the person is asked whether they still want it (owner's choice,
-- 2026-10-10) — never silently dropped.
--
-- Times are written and compared from the app (JS Dates), never NOW(), so
-- the database's own zone cannot shift a reminder.
-- Conventions match 0001-0058: no enforced FKs.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_time_reminder (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid         CHAR(36)        NOT NULL,
  profile_id   BIGINT          NOT NULL,
  text         VARCHAR(300)    NOT NULL,   -- what to remind them, as approved
  fire_at      DATETIME        NOT NULL,   -- UTC
  time_zone    VARCHAR(64)     NULL,       -- how to say the time back to them
  --   armed      waiting for its time
  --   firing     claimed by a job run
  --   done       reached them (or ran out of push attempts; the in-app card stays)
  --   cancelled  removed by the person
  status       VARCHAR(16)     NOT NULL DEFAULT 'armed',
  attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  action_uuid  CHAR(36)        NULL,       -- the athena_action that approved it
  fired_at     DATETIME        NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_time_reminder_uuid (uuid),
  KEY idx_athena_time_reminder_due (status, fire_at),
  KEY idx_athena_time_reminder_profile (profile_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE athena_place_reminder
  ADD COLUMN after_kind       VARCHAR(16)  NULL AFTER repeats,      -- place | time
  ADD COLUMN after_label      VARCHAR(120) NULL AFTER after_kind,   -- "the gym", "soccer ends"
  ADD COLUMN after_latitude   DECIMAL(9,6) NULL AFTER after_label,
  ADD COLUMN after_longitude  DECIMAL(9,6) NULL AFTER after_latitude,
  ADD COLUMN after_at         DATETIME     NULL AFTER after_longitude, -- UTC
  ADD COLUMN condition_met_at DATETIME     NULL AFTER after_at,
  ADD COLUMN expires_at       DATETIME     NULL AFTER condition_met_at, -- UTC
  ADD COLUMN expiry_asked_at  DATETIME     NULL AFTER expires_at,
  ADD KEY idx_athena_place_reminder_expiry (status, expires_at);
