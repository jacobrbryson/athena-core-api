-- Projects: a lens over what Athena already knows, not a container for it.
-- See docs/architecture/projects.md.
--
-- A project holds what only it can hold — the goal, the steps, the links to
-- other projects — and replaces athena_home_project (0037), which was empty in
-- production when this shipped and is left in place, unread, to be dropped later.
--
-- Profile columns follow the codebase convention: plain BIGINT, indexed, no
-- enforced FK. The child tables below hang off athena_project with ON DELETE
-- CASCADE because they have no meaning without it.

CREATE TABLE IF NOT EXISTS athena_project (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  title VARCHAR(190) NOT NULL,
  goal TEXT NULL,
  -- A soft hint (fitness, home, coaching, work, program, ...), never an ENUM.
  kind VARCHAR(32) NULL,
  -- Where the work stands, nothing else. "Blocked" is also derived from
  -- unfinished dependencies; this column is what a person set.
  status ENUM('idea','planning','ready','active','waiting','blocked','done','dropped') NOT NULL DEFAULT 'idea',
  waiting_on VARCHAR(32) NULL,
  -- 1 low · 2 low-medium · 3 medium · 4 high · 5 critical
  priority TINYINT UNSIGNED NOT NULL DEFAULT 3,
  starts_on DATE NULL,
  ends_on DATE NULL,
  hard_deadline DATE NULL,
  -- Optional measurable target. On-track is arithmetic, never a model's opinion.
  metric_source VARCHAR(48) NULL,
  metric_start DECIMAL(10,2) NULL,
  metric_target DECIMAL(10,2) NULL,
  metric_unit VARCHAR(16) NULL,
  effort_min_minutes INT UNSIGNED NULL,
  effort_max_minutes INT UNSIGNED NULL,
  effort_note VARCHAR(64) NULL,
  -- NULL means nobody said. Not the same as false, and never guessed.
  indoor TINYINT(1) NULL,
  cost_diy_low DECIMAL(10,2) NULL,
  cost_diy_high DECIMAL(10,2) NULL,
  cost_pro_low DECIMAL(10,2) NULL,
  cost_pro_high DECIMAL(10,2) NULL,
  cost_note VARCHAR(190) NULL,
  value_note VARCHAR(255) NULL,
  -- Bit 0 = January. NULL = any time of year.
  season_months SMALLINT UNSIGNED NULL,
  conditions JSON NULL,
  serves JSON NULL,
  involves_children TINYINT(1) NOT NULL DEFAULT 0,
  visibility ENUM('private','household') NOT NULL DEFAULT 'private',
  last_progress_at DATETIME NULL,
  completed_at DATETIME NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'manual',
  import_key VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_project_uuid (uuid),
  UNIQUE KEY uq_athena_project_import (profile_id, import_key),
  KEY idx_athena_project_open (profile_id, status, priority),
  KEY idx_athena_project_deadline (profile_id, hard_deadline)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Projects span sections: muscle gain is Health, coaching is Community and
-- Family. Exactly one primary per project, enforced in the service.
CREATE TABLE IF NOT EXISTS athena_project_area (
  project_id BIGINT UNSIGNED NOT NULL,
  area VARCHAR(16) NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, area),
  KEY idx_project_area (area),
  CONSTRAINT fk_project_area_project FOREIGN KEY (project_id) REFERENCES athena_project (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Programs and dependencies. contributes_to is many-to-many ("garage cleanout"
-- feeds both the odor diagnosis and the storage plan); depends_on is what makes
-- a project blocked until another is done. The service rejects cycles.
CREATE TABLE IF NOT EXISTS athena_project_link (
  from_project_id BIGINT UNSIGNED NOT NULL,
  to_project_id BIGINT UNSIGNED NOT NULL,
  relation ENUM('contributes_to','depends_on') NOT NULL,
  note VARCHAR(190) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (from_project_id, to_project_id, relation),
  KEY idx_project_link_to (to_project_id, relation),
  CONSTRAINT fk_project_link_from FOREIGN KEY (from_project_id) REFERENCES athena_project (id) ON DELETE CASCADE,
  CONSTRAINT fk_project_link_to FOREIGN KEY (to_project_id) REFERENCES athena_project (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_project_step (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  ordinal INT NOT NULL DEFAULT 0,
  title VARCHAR(190) NOT NULL,
  detail TEXT NULL,
  status ENUM('todo','in_progress','blocked','done','skipped') NOT NULL DEFAULT 'todo',
  who ENUM('me','someone','athena') NOT NULL DEFAULT 'me',
  blocked_on VARCHAR(190) NULL,
  due_on DATE NULL,
  effort_minutes INT UNSIGNED NULL,
  indoor TINYINT(1) NULL,
  completed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_step_uuid (uuid),
  KEY idx_project_step (project_id, status, ordinal),
  CONSTRAINT fk_project_step_project FOREIGN KEY (project_id) REFERENCES athena_project (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The problems projects exist to solve. Finishing every linked project does
-- not resolve one — a person observing it gone does.
CREATE TABLE IF NOT EXISTS athena_concern (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  area VARCHAR(16) NOT NULL,
  title VARCHAR(190) NOT NULL,
  severity TINYINT UNSIGNED NOT NULL DEFAULT 3,
  frequency VARCHAR(64) NULL,
  likely_cause TEXT NULL,
  goal_impact VARCHAR(255) NULL,
  assessment TEXT NULL,
  status ENUM('open','monitoring','resolved') NOT NULL DEFAULT 'open',
  resolved_at DATETIME NULL,
  import_key VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_concern_uuid (uuid),
  UNIQUE KEY uq_concern_import (profile_id, import_key),
  KEY idx_concern_open (profile_id, area, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_concern_project (
  concern_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (concern_id, project_id),
  KEY idx_concern_project_project (project_id),
  CONSTRAINT fk_concern_project_concern FOREIGN KEY (concern_id) REFERENCES athena_concern (id) ON DELETE CASCADE,
  CONSTRAINT fk_concern_project_project FOREIGN KEY (project_id) REFERENCES athena_project (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- How this person decides, per area: the vision, weighted values, rules.
CREATE TABLE IF NOT EXISTS athena_area_charter (
  profile_id BIGINT NOT NULL,
  area VARCHAR(16) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  weights JSON NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, area)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
