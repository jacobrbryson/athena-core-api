-- Vehicles on the Property page (docs/capabilities/vehicles.md): the cars a
-- person keeps at a property, with the dates that come due (registration,
-- inspection, insurance, next service) and a service history. A vehicle lives
-- at one of the person's properties; property_uuid is checked in code against
-- athena_property, which is keyed by uuid and holds its details as JSON.
--
-- The photo is a resized JPEG data URL, like the property map image. It is
-- never selected when listing, so the list carries no image bytes.
CREATE TABLE IF NOT EXISTS athena_property_vehicle (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  property_uuid CHAR(36) NULL,
  name VARCHAR(100) NOT NULL,
  year SMALLINT NULL,
  make VARCHAR(60) NULL,
  model VARCHAR(60) NULL,
  color VARCHAR(40) NULL,
  plate VARCHAR(20) NULL,
  vin VARCHAR(17) NULL,
  odometer INT UNSIGNED NULL,
  odometer_on DATE NULL,
  registration_due DATE NULL,
  inspection_due DATE NULL,
  insurance_due DATE NULL,
  service_due DATE NULL,
  service_due_miles INT UNSIGNED NULL,
  notes TEXT NULL,
  photo MEDIUMTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_property_vehicle_uuid (uuid),
  KEY idx_property_vehicle_profile (profile_id, property_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Work done on a vehicle: when, at what mileage, what, and where. Deleted with the vehicle.
CREATE TABLE IF NOT EXISTS athena_property_vehicle_service (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  vehicle_id BIGINT UNSIGNED NOT NULL,
  done_on DATE NOT NULL,
  odometer INT UNSIGNED NULL,
  what VARCHAR(500) NOT NULL,
  shop VARCHAR(100) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_property_vehicle_service_uuid (uuid),
  KEY idx_property_vehicle_service (vehicle_id, done_on),
  CONSTRAINT fk_property_vehicle_service FOREIGN KEY (vehicle_id) REFERENCES athena_property_vehicle (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
