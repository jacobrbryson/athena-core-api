DROP TABLE IF EXISTS family_health_schedule;
DROP TABLE IF EXISTS family_health_entry;
ALTER TABLE family_health_status DROP COLUMN time_zone, DROP COLUMN ends_on;
