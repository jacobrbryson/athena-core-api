-- Notes on a property issue (docs/capabilities/property.md): a dated running
-- log the person keeps while they deal with it — "left a voicemail for the
-- HVAC company at 8:45". Deleted with the issue.
CREATE TABLE IF NOT EXISTS athena_property_issue_note (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  issue_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_property_issue_note_uuid (uuid),
  KEY idx_property_issue_note (issue_id, created_at),
  CONSTRAINT fk_property_issue_note FOREIGN KEY (issue_id) REFERENCES athena_property_issue (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
