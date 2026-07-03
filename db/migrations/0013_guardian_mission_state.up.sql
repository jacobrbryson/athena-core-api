-- Persistent campaign-level mission state for the Guardians adventure.
-- No row means the initial family check-in mission is still active.

CREATE TABLE IF NOT EXISTS guardian_mission_state (
  adventure_key          VARCHAR(60) NOT NULL,
  mission_key            VARCHAR(80) NOT NULL,
  status                 VARCHAR(24) NOT NULL,
  started_by_guardian_id VARCHAR(8)  NULL,
  started_at             DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decrypting_at          DATETIME    NULL,
  updated_at             DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (adventure_key),
  KEY idx_guardian_mission_state_mission (mission_key, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
