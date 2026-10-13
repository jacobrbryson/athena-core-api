-- Body calibration: reference measurements (a DEXA scan, an InBody test, a
-- height measured at the doctor's) that correct the smart scale's readings
-- and Athena's own body-composition estimates (services/bodyComposition.js).
-- Each measure is optional; the newest reference carrying a measure is the one
-- that corrects it. Removing a reference soft-deletes it.
CREATE TABLE IF NOT EXISTS body_calibration (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  measured_on DATE NOT NULL,
  source VARCHAR(80) NULL,
  height_cm DECIMAL(5,1) NULL,
  body_fat_percent DECIMAL(4,1) NULL,
  skeletal_muscle_kg DECIMAL(5,2) NULL,
  fat_free_mass_kg DECIMAL(5,2) NULL,
  body_water_percent DECIMAL(4,1) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_body_calibration_uuid (uuid),
  KEY idx_body_calibration_profile (profile_id, measured_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
