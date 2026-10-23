-- Cars linked through Smartcar (docs/capabilities/smartcar.md): the latest
-- reading from each car the person granted, and which of their Property →
-- Vehicles entries it is (matched by VIN, or chosen). A linked car's odometer
-- keeps that vehicle's mileage current. Location is kept only for a car the
-- person turned it on for (location_enabled), and is cleared when turned off.
CREATE TABLE IF NOT EXISTS athena_smartcar_vehicle (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id BIGINT NOT NULL,
  smartcar_id VARCHAR(64) NOT NULL,
  vehicle_id BIGINT UNSIGNED NULL,
  make VARCHAR(60) NULL,
  model VARCHAR(60) NULL,
  year SMALLINT NULL,
  vin VARCHAR(17) NULL,
  odometer_mi INT UNSIGNED NULL,
  fuel JSON NULL,
  battery JSON NULL,
  locked TINYINT(1) NULL,
  location_enabled TINYINT(1) NOT NULL DEFAULT 0,
  latitude DECIMAL(9,6) NULL,
  longitude DECIMAL(9,6) NULL,
  location_at DATETIME NULL,
  synced_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_smartcar_vehicle (profile_id, smartcar_id),
  KEY idx_smartcar_vehicle_link (vehicle_id),
  CONSTRAINT fk_smartcar_vehicle FOREIGN KEY (vehicle_id) REFERENCES athena_property_vehicle (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
