-- Proof that isn't Athena's word, and what a finished mission taught her
-- (docs/capabilities/guardians-missions.md, owner 2026-10-31).
--
-- A secret is set by an adult and only its salted hash is kept, in a table no
-- prompt reads, so she can give hints without being able to give the answer
-- away. A correct code is a check made by code, not her judgment.
ALTER TABLE athena_gm_mission_step
  MODIFY COLUMN proof_required ENUM('none','photo','photo_set','camera_check','kid_confirm','parent_confirm','code') NOT NULL DEFAULT 'photo';

CREATE TABLE IF NOT EXISTS athena_gm_step_secret (
  step_id BIGINT UNSIGNED NOT NULL,
  code_hash CHAR(64) NOT NULL,
  salt CHAR(32) NOT NULL,
  wrong_tries SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  set_by_actor_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (step_id),
  CONSTRAINT fk_gm_secret_step FOREIGN KEY (step_id) REFERENCES athena_gm_mission_step (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What she expected, written when the plan was approved and never changed.
-- actual is filled by code when the step finishes.
CREATE TABLE IF NOT EXISTS athena_gm_prediction (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mission_id BIGINT UNSIGNED NOT NULL,
  step_id BIGINT UNSIGNED NOT NULL,
  predicted_minutes DECIMAL(8,1) NOT NULL,
  actual_minutes DECIMAL(8,1) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_prediction_step (step_id),
  KEY idx_gm_prediction_mission (mission_id),
  CONSTRAINT fk_gm_prediction_step FOREIGN KEY (step_id) REFERENCES athena_gm_mission_step (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One per mission: the criteria locked at approval, graded by code.
CREATE TABLE IF NOT EXISTS athena_gm_debrief (
  mission_id BIGINT UNSIGNED NOT NULL,
  family_id BIGINT NOT NULL,
  results JSON NOT NULL,
  passed SMALLINT UNSIGNED NOT NULL,
  total SMALLINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (mission_id),
  KEY idx_gm_debrief_family (family_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A weakness is a specific thing that went wrong, with the mission that showed
-- it. Self-evaluation reads these; a later passing test resolves one.
CREATE TABLE IF NOT EXISTS athena_gm_weakness (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT NOT NULL,
  mission_id BIGINT UNSIGNED NOT NULL,
  cap_key VARCHAR(60) NULL,
  summary VARCHAR(255) NOT NULL,
  resolved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_gm_weakness_open (family_id, resolved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A person's skill can now point at the mission that showed it.
ALTER TABLE athena_gm_actor_capability
  ADD COLUMN evidence_mission_id BIGINT UNSIGNED NULL AFTER source;
