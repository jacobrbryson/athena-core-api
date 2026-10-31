-- Missions across families, kids pressing Go, and switches the owner can flip
-- (docs/capabilities/guardians-missions.md, owner 2026-10-31).
--
-- A partner family joins one mission at a time. Its parent decides for its own
-- kids; nobody can add another family's kid. A family that leaves stops the
-- mission.
CREATE TABLE IF NOT EXISTS athena_gm_mission_family (
  mission_id BIGINT UNSIGNED NOT NULL,
  family_id BIGINT NOT NULL,
  status ENUM('invited','accepted','declined','left') NOT NULL DEFAULT 'invited',
  invited_by_actor_id BIGINT UNSIGNED NOT NULL,
  decided_by_actor_id BIGINT UNSIGNED NULL,
  decided_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (mission_id, family_id),
  KEY idx_gm_mission_family (family_id, status),
  CONSTRAINT fk_gm_mf_mission FOREIGN KEY (mission_id) REFERENCES athena_gm_mission (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Whether a kid may press Go on a mission under this template. The owner says
-- so per template; it is never assumed.
ALTER TABLE athena_gm_template
  ADD COLUMN allow_kid_go TINYINT(1) NOT NULL DEFAULT 0 AFTER max_minutes;

-- Switches only someone with can_create_templates can change, so turning one
-- on or off doesn't need a deploy.
CREATE TABLE IF NOT EXISTS athena_gm_setting (
  setting_key VARCHAR(40) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  updated_by_actor_id BIGINT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Owner, 2026-10-31: templates on. Chat consent stays off until every Guardian
-- login has a family set up to agree.
INSERT INTO athena_gm_setting (setting_key, enabled) VALUES ('templates', 1), ('chat_consent', 0)
ON DUPLICATE KEY UPDATE setting_key = setting_key;
