-- Chosen pictures for watched places; separate from the incident watch reads.
CREATE TABLE IF NOT EXISTS athena_watch_place_photo (
  profile_id BIGINT NOT NULL,
  place_uuid CHAR(36) NOT NULL,
  image MEDIUMBLOB NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, place_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
