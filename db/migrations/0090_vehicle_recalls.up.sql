-- Safety recalls for the vehicles on Property → Vehicles (docs/capabilities/
-- vehicles.md), from NHTSA's free recalls API by make, model and model year
-- (the VIN, when there is one, is decoded through NHTSA vPIC for those). The
-- API lists recalls for the model year, not whether this car was repaired, so
-- each starts 'open' until the person marks it done or not applicable.
-- park_it / park_outside are NHTSA's own "don't drive" and "park outside"
-- flags. Refreshed nightly by services/vehicleRecalls.js; removed with the car.
CREATE TABLE IF NOT EXISTS athena_vehicle_recall (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vehicle_id BIGINT UNSIGNED NOT NULL,
  campaign VARCHAR(20) NOT NULL,
  component VARCHAR(200) NULL,
  summary TEXT NULL,
  consequence TEXT NULL,
  remedy TEXT NULL,
  reported_on DATE NULL,
  park_it TINYINT(1) NOT NULL DEFAULT 0,
  park_outside TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('open','done','not_applicable') NOT NULL DEFAULT 'open',
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_vehicle_recall (vehicle_id, campaign),
  CONSTRAINT fk_vehicle_recall_vehicle FOREIGN KEY (vehicle_id) REFERENCES athena_property_vehicle (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- When recalls were last looked up for each vehicle, and what NHTSA's VIN
-- decode said it is (so a typo in make/model doesn't hide its recalls).
ALTER TABLE athena_property_vehicle
  ADD COLUMN recalls_checked_at DATETIME NULL AFTER notes,
  ADD COLUMN decoded JSON NULL AFTER recalls_checked_at;
