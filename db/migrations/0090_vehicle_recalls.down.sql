ALTER TABLE athena_property_vehicle DROP COLUMN decoded, DROP COLUMN recalls_checked_at;
DROP TABLE IF EXISTS athena_vehicle_recall;
