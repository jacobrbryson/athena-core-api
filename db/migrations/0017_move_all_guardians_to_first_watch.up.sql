-- Mission 3 "The First Watch" is now the active campaign for every Guardian.
--
-- Rescue Ratatouille remains in guardian_adventure as historical enrollment,
-- but it must no longer be anybody's primary/effective adventure. Keeping the
-- old enrollment preserves past trail records without routing new sessions
-- back to Mission 1.

INSERT INTO guardian_adventure (guardian_id, adventure_key, is_primary)
SELECT guardian_id, 'lake_norman_guardians', 1
  FROM guardian_credential
 WHERE is_active = 1
ON DUPLICATE KEY UPDATE is_primary = 1;

UPDATE guardian_adventure ga
JOIN guardian_credential gc ON gc.guardian_id = ga.guardian_id
   SET ga.is_primary = IF(ga.adventure_key = 'lake_norman_guardians', 1, 0)
 WHERE gc.is_active = 1;

UPDATE guardian_credential
   SET adventure_key = 'lake_norman_guardians'
 WHERE is_active = 1
   AND adventure_key <> 'lake_norman_guardians';
