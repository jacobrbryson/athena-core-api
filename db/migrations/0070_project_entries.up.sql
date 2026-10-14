-- A project's journal: notes, photos, decisions (docs/architecture/projects.md).
--
-- Photos of adults' projects are stored in a private bucket (media_uri, gs://)
-- and served through the API. Photos of children never leave the device: the
-- row carries only the caption and an opaque device_ref, and the service
-- refuses image bytes for any project or entry that involves children.
CREATE TABLE IF NOT EXISTS athena_project_entry (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  step_id BIGINT UNSIGNED NULL,
  type ENUM('note','photo','decision','measurement') NOT NULL,
  phase ENUM('concept','before','progress','after','memory') NULL,
  body TEXT NULL,
  media_location ENUM('server','device') NULL,
  media_uri VARCHAR(512) NULL,
  device_ref VARCHAR(64) NULL,
  involves_children TINYINT(1) NOT NULL DEFAULT 0,
  source VARCHAR(16) NOT NULL DEFAULT 'manual',
  taken_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_entry_uuid (uuid),
  KEY idx_project_entry (project_id, created_at),
  CONSTRAINT fk_project_entry_project FOREIGN KEY (project_id) REFERENCES athena_project (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
