-- =====================================================================
-- 0007_guardian_player_profile.down.sql
-- =====================================================================

DROP TABLE IF EXISTS guardian_adventure;

ALTER TABLE guardian_credential
  DROP COLUMN IF EXISTS city,
  DROP COLUMN IF EXISTS email;
