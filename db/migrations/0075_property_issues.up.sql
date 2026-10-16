-- Property issues: something wrong at the house right now, reported from the
-- Property page (docs/capabilities/property.md). Distinct from concerns, which
-- are standing problems projects answer; an issue is a dated report with a
-- severity, a place, and optional photos, and it is open until resolved.
--
-- Photos are resized JPEG data URLs, the same shape the property map image
-- uses, kept in their own table so listing issues never carries image bytes.
CREATE TABLE IF NOT EXISTS athena_property_issue (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  location VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  severity ENUM('low','medium','high','emergency') NOT NULL,
  noticed_on DATE NOT NULL,
  notes TEXT NULL,
  status ENUM('open','resolved') NOT NULL DEFAULT 'open',
  resolved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_property_issue_uuid (uuid),
  KEY idx_property_issue_profile (profile_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_property_issue_photo (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  issue_id BIGINT UNSIGNED NOT NULL,
  image MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_property_issue_photo_uuid (uuid),
  KEY idx_property_issue_photo (issue_id),
  CONSTRAINT fk_property_issue_photo FOREIGN KEY (issue_id) REFERENCES athena_property_issue (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
