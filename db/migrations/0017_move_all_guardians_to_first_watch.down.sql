-- Restore the Rescue-only credentials that existed when 0017 was introduced.
-- This is intentionally explicit so rollback cannot move newer Guardians into
-- an old campaign by accident.

UPDATE guardian_credential
   SET adventure_key = 'rescue_ratatouille'
 WHERE guardian_id IN ('12345678', '20250501', '20250601', '20250602', '87654321');

UPDATE guardian_adventure
   SET is_primary = IF(adventure_key = 'rescue_ratatouille', 1, 0)
 WHERE guardian_id IN ('12345678', '20250501', '20250601', '20250602', '87654321');

DELETE FROM guardian_adventure
 WHERE guardian_id IN ('12345678', '20250501', '20250601', '20250602', '87654321')
   AND adventure_key = 'lake_norman_guardians';
