UPDATE athena_vehicle_recall SET status = 'open' WHERE status = 'acknowledged';
ALTER TABLE athena_vehicle_recall
  MODIFY COLUMN status ENUM('open','done','not_applicable') NOT NULL DEFAULT 'open';

ALTER TABLE athena_property_vehicle
  DROP COLUMN inspection_station,
  DROP COLUMN registration_number,
  DROP COLUMN registration_state;
