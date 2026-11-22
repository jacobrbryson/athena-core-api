-- =====================================================================
-- 0121_family_health_schedules.up.sql
-- Family health watch, page of its own (owner, 2026-11-22): editable
-- start/end dates, a history of every update instead of only the last one,
-- and recurring checks ("temperature every 6 hours, medicine every 12")
-- that can be ticked off in the app and push when one comes due unticked.
-- ---------------------------------------------------------------------
-- family_health_status gains:
--   ends_on    — a planned end (the last day of a course of medicine).
--                Checks stop pushing after it; the watch stays active
--                until someone ends it. For a resolved watch, resolved_at
--                is its end and stays editable.
--   time_zone  — the zone the person was in when they last set dates or
--                checks, so "until Friday" means their Friday.
--
-- family_health_entry: one row per thing logged on a watch — the report
-- that started it, each update, each check ticked off or skipped, the end.
-- Never rewritten when a newer update arrives.
--
-- family_health_schedule: a recurring check. next_due_at is the one
-- occurrence waiting; ticking it off moves it to (when it was done) +
-- every_hours, so a late dose doesn't put the next one too close. The
-- push_* columns claim the one push for the occurrence in next_due_at, the
-- way athena_time_reminder claims its send.
--
-- Conventions match 0001-0120: BIGINT UNSIGNED ids, no enforced FKs,
-- idempotent where MySQL allows.
-- =====================================================================

ALTER TABLE family_health_status
  ADD COLUMN ends_on   DATE        NULL AFTER resolved_at,
  ADD COLUMN time_zone VARCHAR(64) NULL AFTER ends_on;

CREATE TABLE IF NOT EXISTS family_health_entry (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid                 CHAR(36)        NOT NULL,
  status_id            BIGINT UNSIGNED NOT NULL,
  family_id            BIGINT UNSIGNED NOT NULL,
  kind                 VARCHAR(20)     NOT NULL, -- started | update | check | skip | ended
  symptom              VARCHAR(200)    NULL,
  severity             VARCHAR(20)     NULL,
  note                 VARCHAR(500)    NULL,
  schedule_id          BIGINT UNSIGNED NULL,
  due_at               DATETIME        NULL,     -- for a check: the occurrence it answered
  logged_at            DATETIME        NOT NULL,
  logged_by_profile_id BIGINT          NULL,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at           DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_family_health_entry_uuid (uuid),
  KEY idx_family_health_entry_status (status_id, logged_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS family_health_schedule (
  id                    BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  uuid                  CHAR(36)         NOT NULL,
  status_id             BIGINT UNSIGNED  NOT NULL,
  family_id             BIGINT UNSIGNED  NOT NULL,
  label                 VARCHAR(120)     NOT NULL,
  kind                  VARCHAR(20)      NOT NULL DEFAULT 'check', -- check | medicine
  every_hours           SMALLINT UNSIGNED NOT NULL,
  next_due_at           DATETIME         NOT NULL,
  ends_at               DATETIME         NULL,
  last_done_at          DATETIME         NULL,
  created_by_profile_id BIGINT           NOT NULL,
  pushed_for            DATETIME         NULL,     -- the next_due_at a push was claimed for
  push_state            VARCHAR(10)      NULL,     -- firing | sent
  push_claimed_at       DATETIME         NULL,
  push_attempts         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  push_retry_at         DATETIME         NULL,
  created_at            DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at            DATETIME         NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_family_health_schedule_uuid (uuid),
  KEY idx_family_health_schedule_status (status_id),
  KEY idx_family_health_schedule_due (deleted_at, next_due_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every existing watch gets its starting report, so its history isn't blank.
INSERT INTO family_health_entry (uuid, status_id, family_id, kind, symptom, severity, note, logged_at, logged_by_profile_id)
SELECT UUID(), s.id, s.family_id, 'started', s.symptom, s.severity, s.notes, COALESCE(s.last_update_at, s.created_at), s.reported_by_profile_id
  FROM family_health_status s
 WHERE s.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM family_health_entry e WHERE e.status_id = s.id);
