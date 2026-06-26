-- =====================================================================
-- 0009_guardian_permanent_qr.down.sql
-- =====================================================================
ALTER TABLE guardian_credential
  DROP KEY IF EXISTS uq_guardian_qr_token_hash,
  DROP COLUMN IF EXISTS qr_token_hash;
