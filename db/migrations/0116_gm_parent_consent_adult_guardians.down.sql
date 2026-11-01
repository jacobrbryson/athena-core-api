-- Once anyone has agreed to version 2 the foreign key refuses this: their
-- record keeps the words they saw.
DELETE FROM athena_gm_consent_terms WHERE audience = 'parent_for_child' AND version = 2;
ALTER TABLE athena_gm_actor DROP COLUMN is_adult;
