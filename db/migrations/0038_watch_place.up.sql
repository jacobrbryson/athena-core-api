-- Places a person wants watched for nearby emergencies: home, a parent's
-- house, a school. Typed by the person (or seeded for them), never derived
-- from location history — athena_location_sample is "where the phone is",
-- this is "where I care about". See docs/capabilities/nearby-incidents.md.
CREATE TABLE IF NOT EXISTS athena_watch_place (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  name VARCHAR(60) NOT NULL,
  address VARCHAR(255) NULL,
  latitude DECIMAL(9,6) NOT NULL,
  longitude DECIMAL(9,6) NOT NULL,
  radius_miles DECIMAL(5,2) NOT NULL DEFAULT 3.00,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_watch_place_uuid (uuid),
  UNIQUE KEY uq_athena_watch_place_name (profile_id, name),
  KEY idx_athena_watch_place_profile (profile_id, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The owner's home, which they gave on 2026-09-21.
INSERT INTO athena_watch_place (uuid, profile_id, name, address, latitude, longitude, radius_miles)
VALUES (UUID(), 1, 'Home', '148 Rushing Water Lane, Troutman, NC 28166', 35.674100, -80.907300, 3.00)
ON DUPLICATE KEY UPDATE latitude = VALUES(latitude), longitude = VALUES(longitude), address = VALUES(address);
