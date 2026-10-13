-- =====================================================================
-- 0064_workplace.up.sql
-- Workplaces: where the person works, and what they do there (owner,
-- 2026-10-13). One person can have several — a primary job and a company
-- they co-own — and Athena needs to tell them apart when she talks about
-- work. See docs/capabilities/workplaces.md.
--
-- Only what the person typed. The per-workplace tokens the owner wants next
-- (Jira, GitHub, OpenAI, Claude) are not here: when they come they belong in
-- user_credential (0024), encrypted, pointing at a workplace — never in this
-- table, which is plain text.
--
-- Conventions match 0001-0063: no enforced FKs (integrity in the service).
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_workplace (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid        CHAR(36)        NOT NULL,
  profile_id  BIGINT          NOT NULL,
  name        VARCHAR(120)    NOT NULL,   -- "Vivacity Tech PBC"
  role        VARCHAR(160)    NULL,       -- "Senior Software Engineer"
  domain      VARCHAR(190)    NULL,       -- "vivacitytech.com", no scheme or www
  is_primary  TINYINT(1)      NOT NULL DEFAULT 0,   -- at most one per person, kept by the service
  notes       VARCHAR(500)    NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_workplace_uuid (uuid),
  UNIQUE KEY uq_athena_workplace_name (profile_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
