-- =====================================================================
-- 0043_family_health_watch.up.sql
-- Family health watch: a lightweight, family-scoped record of "someone is
-- under the weather" — who, what symptom, since when — so the companion
-- dashboard can show it and Athena's chat context and initiative trigger
-- can be aware of it without a person having to repeat themselves.
-- ---------------------------------------------------------------------
-- One active row per (family_id, person_name): reporting again on the same
-- person while a status is still active updates that row (see
-- services/familyHealth.js) rather than stacking duplicates. `person_name`
-- is free text rather than a family_members/profile reference — a
-- companion-only adult may report on a family member (a baby, a visiting
-- relative) who has no profile row of their own.
--
-- Conventions match 0001-0042: BIGINT UNSIGNED ids, no enforced FKs
-- (integrity in the service layer), idempotent CREATE TABLE IF NOT EXISTS.
-- =====================================================================

CREATE TABLE IF NOT EXISTS family_health_status (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid                   CHAR(36)        NOT NULL,
  family_id              BIGINT UNSIGNED NOT NULL,
  person_name            VARCHAR(120)    NOT NULL,
  symptom                VARCHAR(200)    NOT NULL,
  severity               VARCHAR(20)     NOT NULL DEFAULT 'mild', -- mild | moderate | severe
  status                 VARCHAR(20)     NOT NULL DEFAULT 'active', -- active | resolved
  started_at             DATE            NOT NULL,
  resolved_at            DATE            NULL,
  notes                  VARCHAR(500)    NULL,
  reported_by_profile_id BIGINT          NULL,
  created_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at             DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_family_health_status_uuid (uuid),
  KEY idx_family_health_status_family (family_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
