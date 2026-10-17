-- =====================================================================
-- 0079_work_page.up.sql
-- The Work page as workspaces (owner, 2026-10-16): each workplace now owns
-- its sites and its projects as well as its connections and addresses, and
-- every site is checked for being up and how fast it answers.
--
-- Sites and projects join a workplace the way connections do (0065): one
-- row in athena_workplace_link, exclusive by the two new unique keys — a
-- site or a project belongs to at most one workplace. kind = 'site' points
-- at athena_site.uuid, kind = 'project' at athena_project.uuid.
--
-- athena_site_check is one row per uptime check: the site answered or it
-- didn't, the HTTP status, and how long it took. Only the latest few days
-- are kept (siteChecks.prune, two weeks). See docs/capabilities/workplaces.md.
--
-- Conventions match 0001-0078: no enforced FKs (integrity in the service).
-- =====================================================================

ALTER TABLE athena_workplace_link
  ADD COLUMN site_uuid CHAR(36) NULL AFTER email,
  ADD COLUMN project_uuid CHAR(36) NULL AFTER site_uuid,
  ADD UNIQUE KEY uq_athena_workplace_link_site (profile_id, site_uuid),
  ADD UNIQUE KEY uq_athena_workplace_link_project (profile_id, project_uuid);

CREATE TABLE IF NOT EXISTS athena_site_check (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id     BIGINT UNSIGNED NOT NULL,
  checked_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ok          TINYINT(1)      NOT NULL,
  status_code SMALLINT UNSIGNED NULL,     -- the HTTP status; NULL when nothing answered
  ms          INT UNSIGNED    NULL,       -- time to the response headers
  error       VARCHAR(190)    NULL,       -- what went wrong, in words
  PRIMARY KEY (id),
  KEY idx_athena_site_check_latest (site_id, checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
