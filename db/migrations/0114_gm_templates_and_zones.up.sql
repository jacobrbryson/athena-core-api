-- Handing off approvals (docs/capabilities/guardians-missions.md, owner
-- 2026-10-31). A template is a kind of mission the owner has approved once, with
-- limits. A draft inside those limits can be started by any adult without the
-- owner reviewing it. A person still clicks, and the click is recorded. Templates
-- are off until GM_TEMPLATES_ENABLED=on.
--
-- A zone is an area an adult has approved for kids to scout on their own.
CREATE TABLE IF NOT EXISTS athena_gm_zone (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  off_limits VARCHAR(300) NOT NULL,
  lat DECIMAL(10,7) NULL,
  lng DECIMAL(10,7) NULL,
  radius_m INT UNSIGNED NULL,
  daylight_only TINYINT(1) NOT NULL DEFAULT 1,
  max_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  retired_at DATETIME NULL,
  created_by_actor_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_zone_uuid (uuid),
  KEY idx_gm_zone_family (family_id, retired_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_gm_template (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  capability_keys JSON NOT NULL,
  actor_keys JSON NOT NULL,
  zone_uuids JSON NOT NULL,
  max_minutes SMALLINT UNSIGNED NOT NULL,
  approval_action_uuid CHAR(36) NOT NULL,
  created_by_actor_id BIGINT UNSIGNED NOT NULL,
  retired_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_template_uuid (uuid),
  KEY idx_gm_template_family (family_id, retired_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE athena_gm_mission
  ADD COLUMN template_id BIGINT UNSIGNED NULL AFTER weakness_id;

-- Who may create a template. Set here and by no route or page, so it can only
-- be changed deliberately. The owner helps create templates first.
ALTER TABLE athena_gm_actor
  ADD COLUMN can_create_templates TINYINT(1) NOT NULL DEFAULT 0 AFTER audience;

UPDATE athena_gm_actor SET can_create_templates = 1 WHERE actor_key = 'ross' AND kind = 'parent';
