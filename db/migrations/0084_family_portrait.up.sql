-- A person-chosen portrait belongs to a remembered family member, independently
-- of Google Contacts. The API limits uploaded JPEGs to 128 KiB.
CREATE TABLE IF NOT EXISTS athena_family_portrait (
  profile_id BIGINT NOT NULL,
  fact_uuid CHAR(36) NOT NULL,
  image MEDIUMBLOB NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, fact_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
