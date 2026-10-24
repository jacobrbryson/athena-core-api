-- =====================================================================
-- 0093_guardian_engine.up.sql
-- The Guardian Engine: household safety protocols (the 10 PM sweep, the
-- storm umbrella watch), their runs, observations, incidents, notifications
-- and history. See src/services/guardianEngine/ and
-- docs/architecture/guardian-engine.md.
--
-- Owner specification, 2026-10-23. Tables are athena_guard_* so they are
-- never confused with the guardian_* identity tables (Guardians are people).
--
-- household_id: today one household per deployment (the Eufy bridge and
-- EUFY_AUTHORIZED_PROFILE_IDS), always 1. Every query filters on it, so a
-- second household is a data change, not a schema change.
-- Conventions match 0001-0092: no enforced FKs.
-- =====================================================================

-- Per-household protocol configuration. No row = the protocol is off.
CREATE TABLE IF NOT EXISTS athena_guard_protocol (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  household_id  BIGINT UNSIGNED NOT NULL,
  protocol_id   VARCHAR(40)     NOT NULL,  -- nightly_sweep | storm_umbrella
  version       INT UNSIGNED    NOT NULL,
  enabled       TINYINT(1)      NOT NULL DEFAULT 0,
  config        JSON            NOT NULL,  -- schedule, cameras, thresholds, recipients, quiet window, autonomy, simulation
  updated_by    BIGINT          NOT NULL,  -- profile id of the adult who last saved it
  updated_at    DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_guard_protocol (household_id, protocol_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One execution of a protocol. The unique occurrence key is the idempotency
-- guarantee: tonight's sweep is '2026-10-23', a storm watch is
-- 'storm:2026-10-23', a recheck is 'recheck:<incident>:<n>', a manual run is
-- 'manual:<uuid>'. A second scheduler inserting the same key is a no-op.
CREATE TABLE IF NOT EXISTS athena_guard_run (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid             CHAR(36)        NOT NULL,
  household_id     BIGINT UNSIGNED NOT NULL,
  protocol_id      VARCHAR(40)     NOT NULL,
  protocol_version INT UNSIGNED    NOT NULL,
  occurrence_key   VARCHAR(80)     NOT NULL,
  trigger_kind     VARCHAR(12)     NOT NULL,  -- schedule | weather | recheck | manual
  state            VARCHAR(20)     NOT NULL,  -- scheduled | observing | evaluating | safe | attention_required | unknown | notified | failed | expired | suppressed
  scheduled_for    DATETIME(3)     NOT NULL,
  lease_until      DATETIME(3)     NULL,      -- an observing run whose lease ran out may be claimed again
  attempts         INT UNSIGNED    NOT NULL DEFAULT 0,
  started_at       DATETIME(3)     NULL,
  finished_at      DATETIME(3)     NULL,
  incident_id      BIGINT UNSIGNED NULL,      -- the incident a recheck run is for
  checks           JSON            NULL,      -- which checks this run performs
  summary          JSON            NULL,      -- per-check outcome, weather read, reasons
  simulated        TINYINT(1)      NOT NULL DEFAULT 0,
  requested_by     BIGINT          NULL,      -- profile id for a manual run
  created_at       DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_guard_run_uuid (uuid),
  UNIQUE KEY uq_athena_guard_run_occurrence (household_id, protocol_id, occurrence_key),
  KEY ix_athena_guard_run_due (state, scheduled_for)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What one check saw. Every row carries its timestamps and confidence; a row
-- with fresh = 0 is never evidence of safety.
CREATE TABLE IF NOT EXISTS athena_guard_observation (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id        BIGINT UNSIGNED NOT NULL,
  household_id  BIGINT UNSIGNED NOT NULL,
  check_id      VARCHAR(40)     NOT NULL,  -- garage_door | patio_umbrella
  subject_key   VARCHAR(80)     NOT NULL,  -- which door / umbrella
  source        VARCHAR(12)     NOT NULL,  -- camera | sensor | weather | fused | scenario
  status        VARCHAR(16)     NOT NULL,  -- closed | open | down | up | unknown | offline | not_applicable
  confidence    DECIMAL(4,3)    NULL,
  captured_at   DATETIME(3)     NULL,      -- when the frame/reading was taken
  observed_at   DATETIME(3)     NOT NULL,  -- when it was evaluated
  fresh         TINYINT(1)      NOT NULL DEFAULT 0,
  attempt       INT UNSIGNED    NOT NULL DEFAULT 1,
  reason        VARCHAR(300)    NULL,
  evidence_media_uuid CHAR(36)  NULL,      -- athena_security_media.uuid, kept only for unsafe/unknown
  device_serial VARCHAR(40)     NULL,
  model         VARCHAR(80)     NULL,
  PRIMARY KEY (id),
  KEY ix_athena_guard_observation_run (run_id),
  KEY ix_athena_guard_observation_subject (household_id, check_id, subject_key, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An unsafe or unverifiable condition, held until it is verified fixed or an
-- adult dismisses it. open_key is 'check:subject' while open and NULL once
-- closed: the unique index is the dedupe for "the same unresolved issue".
CREATE TABLE IF NOT EXISTS athena_guard_incident (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid                CHAR(36)        NOT NULL,
  household_id        BIGINT UNSIGNED NOT NULL,
  protocol_id         VARCHAR(40)     NOT NULL,
  check_id            VARCHAR(40)     NOT NULL,
  subject_key         VARCHAR(80)     NOT NULL,
  open_key            VARCHAR(130)    NULL,
  state               VARCHAR(16)     NOT NULL,  -- open | notified | acknowledged | resolved | dismissed | expired
  condition_status    VARCHAR(16)     NOT NULL,  -- open | up | unknown | offline
  severity            VARCHAR(10)     NOT NULL,  -- urgent | advisory
  confidence          DECIMAL(4,3)    NULL,
  trigger_run_id      BIGINT UNSIGNED NOT NULL,
  trigger_kind        VARCHAR(12)     NOT NULL,
  last_observation_id BIGINT UNSIGNED NULL,
  first_detected_at   DATETIME(3)     NOT NULL,
  last_verified_at    DATETIME(3)     NOT NULL,
  acknowledged_by     BIGINT          NULL,
  acknowledged_at     DATETIME(3)     NULL,
  assigned_profile_id BIGINT          NULL,
  resolved_at         DATETIME(3)     NULL,
  resolution          VARCHAR(20)     NULL,      -- verified_safe | dismissed | expired
  dismissed_by        BIGINT          NULL,
  dismiss_reason      VARCHAR(300)    NULL,
  recheck_count       INT UNSIGNED    NOT NULL DEFAULT 0,
  next_recheck_at     DATETIME(3)     NULL,
  expires_at          DATETIME(3)     NULL,      -- umbrella incidents lapse once the weather risk has passed
  escalated_at        DATETIME(3)     NULL,
  context             JSON            NULL,      -- weather reasons, camera name, wording facts
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_guard_incident_uuid (uuid),
  UNIQUE KEY uq_athena_guard_incident_open (household_id, open_key),
  KEY ix_athena_guard_incident_recheck (state, next_recheck_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each alert to each person. Unique per (incident, person, kind): an incident
-- is told once, escalated at most once, and its resolution said once.
CREATE TABLE IF NOT EXISTS athena_guard_notification (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  incident_id   BIGINT UNSIGNED NOT NULL,
  household_id  BIGINT UNSIGNED NOT NULL,
  profile_id    BIGINT          NOT NULL,
  kind          VARCHAR(12)     NOT NULL,  -- alert | escalation | resolved
  status        VARCHAR(12)     NOT NULL,  -- pending | sent | held | failed | simulated | in_app | superseded
  attempts      INT UNSIGNED    NOT NULL DEFAULT 0,
  text          VARCHAR(600)    NOT NULL,
  nudge_uuid    CHAR(36)        NULL,
  result        JSON            NULL,      -- per-transport outcome of the last attempt
  hold_until    DATETIME(3)     NULL,
  last_attempt_at DATETIME(3)   NULL,
  created_at    DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_guard_notification (incident_id, profile_id, kind),
  KEY ix_athena_guard_notification_status (status, hold_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- History: state changes, policy decisions, acknowledgements, config changes.
CREATE TABLE IF NOT EXISTS athena_guard_event (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  household_id  BIGINT UNSIGNED NOT NULL,
  run_id        BIGINT UNSIGNED NULL,
  incident_id   BIGINT UNSIGNED NULL,
  kind          VARCHAR(40)     NOT NULL,
  actor         VARCHAR(40)     NOT NULL,  -- 'engine' or 'profile:<id>'
  detail        JSON            NULL,
  at            DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_athena_guard_event_household (household_id, at),
  KEY ix_athena_guard_event_incident (incident_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
