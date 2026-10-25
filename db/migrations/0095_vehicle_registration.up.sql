-- =====================================================================
-- 0095_vehicle_registration.up.sql
-- Registration details on a vehicle, and "acknowledged" for a recall.
--
-- The owner's X5 registration and inspection came due with nowhere obvious
-- to keep the registration itself (2026-10-25): the state it's registered
-- in, the registration number on the card, and where it's inspected. The
-- due dates were already here (0078); these sit beside them.
--
-- A recall can now be 'acknowledged' — seen, not yet repaired — between
-- 'open' and 'done' (which the app now calls Repaired). It stays in her
-- prompt as unrepaired; only 'open' ones are new to the person.
-- =====================================================================
ALTER TABLE athena_property_vehicle
  ADD COLUMN registration_state CHAR(2) NULL AFTER vin,
  ADD COLUMN registration_number VARCHAR(40) NULL AFTER registration_state,
  ADD COLUMN inspection_station VARCHAR(100) NULL AFTER registration_number;

ALTER TABLE athena_vehicle_recall
  MODIFY COLUMN status ENUM('open','acknowledged','done','not_applicable') NOT NULL DEFAULT 'open';
