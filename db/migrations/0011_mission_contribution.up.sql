-- =====================================================================
-- 0011_mission_contribution.up.sql
-- Per-family contributions to cooperative missions (e.g. Mission 2
-- "Convergence", where each Guardian family reports the piece of the path
-- it holds and the destination is only revealed once every family is in).
-- ---------------------------------------------------------------------
-- One row per (mission, adventure, family). A family contributes at most
-- once; re-reporting is idempotent (ON DUPLICATE KEY in the service layer).
-- The fragment each family holds is authored in src/config/missions.js and
-- copied here at report time so progress is auditable. Conventions match
-- 0001-0010: BIGINT UNSIGNED ids, no enforced FKs, idempotent create.
-- =====================================================================

CREATE TABLE IF NOT EXISTS mission_contribution (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mission_key   VARCHAR(80)     NOT NULL,            -- e.g. mission-2-convergence
  adventure_key VARCHAR(60)     NOT NULL,            -- e.g. lake_norman_guardians
  family_key    VARCHAR(80)     NOT NULL,            -- lowercased family surname
  guardian_id   VARCHAR(8)      NOT NULL,            -- who reported on behalf of the family
  fragment      VARCHAR(120)    NULL,                -- the piece the family contributed
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mission_family (mission_key, adventure_key, family_key),
  KEY idx_mission_contribution_lookup (mission_key, adventure_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
