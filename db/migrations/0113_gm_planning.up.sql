-- Planning mode (docs/capabilities/guardians-missions.md, owner 2026-10-31).
-- Athena drafts missions as ordinary proposed rows, so a draft has no more
-- power than any other proposal: an adult approves it or it does nothing.
--
-- A wish is something she'd like to be able to do. It grants nothing: no
-- capability row, no access. A plan that depends on one can't be approved until
-- a person has built it. Building stays with people, including any code fix,
-- purchase or hardware.
CREATE TABLE IF NOT EXISTS athena_gm_wish (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  mission_id BIGINT UNSIGNED NULL,
  name VARCHAR(120) NOT NULL,
  why VARCHAR(500) NOT NULL,
  cost VARCHAR(120) NULL,
  status ENUM('wanted','built','declined') NOT NULL DEFAULT 'wanted',
  decided_by_actor_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_wish_uuid (uuid),
  KEY idx_gm_wish_family (family_id, status),
  KEY idx_gm_wish_mission (mission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The weakness a draft sets out to fix, when it came from one.
ALTER TABLE athena_gm_mission
  ADD COLUMN weakness_id BIGINT UNSIGNED NULL AFTER purpose;
