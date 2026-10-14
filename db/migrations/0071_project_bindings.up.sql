-- Project bindings: how a project reads data Athena already has, live, instead
-- of copying it (docs/architecture/projects.md). A binding is a selector over a
-- source the person has already connected — weight from the scale, WHOOP
-- workouts by sport, calendar events by title — interpreted by code, never by
-- a model. Only `confirmed` bindings are read; one the person adds is
-- confirmed at once, one Athena proposes waits for them.
CREATE TABLE IF NOT EXISTS athena_project_binding (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  selector JSON NOT NULL,
  status ENUM('proposed','confirmed','rejected') NOT NULL DEFAULT 'proposed',
  proposed_by ENUM('owner','athena') NOT NULL,
  confirmed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_binding_uuid (uuid),
  KEY idx_project_binding (project_id, status),
  CONSTRAINT fk_project_binding_project FOREIGN KEY (project_id) REFERENCES athena_project (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
