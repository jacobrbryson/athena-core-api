-- =====================================================================
-- 0006_guardian_login_token.up.sql
-- Single-use QR login tokens for Guardians.
-- ---------------------------------------------------------------------
-- A Guardian's permanent credential (guardian_credential, 0005) is an
-- 8-digit ID + 6-char secret typed at the gate. For QR codes we never put
-- that secret in a URL. Instead we issue a high-entropy, single-use token
-- that maps to a credential, can be redeemed exactly once, and expires.
--
-- Only a fast hash (SHA-256 hex) of the token is stored — the plaintext is
-- shown once at issuance (encoded into the QR) and never persisted. The
-- token is high-entropy, so unlike the 6-char secret it does not need a
-- slow salted KDF; a deterministic hash lets us look it up by value.
--
-- Single-use is enforced atomically at redeem time:
--   UPDATE ... SET used_at = NOW()
--   WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW();
-- exactly one redeemer sees affectedRows = 1.
--
-- Conventions match 0001-0005: BIGINT UNSIGNED ids, no enforced FKs
-- (integrity in the service layer), idempotent CREATE TABLE IF NOT EXISTS.
-- =====================================================================

CREATE TABLE IF NOT EXISTS guardian_login_token (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  credential_id BIGINT UNSIGNED NOT NULL,          -- -> guardian_credential.id
  token_hash    CHAR(64)        NOT NULL,          -- SHA-256 hex of the token
  expires_at    DATETIME        NOT NULL,          -- invalid once passed
  used_at       DATETIME        NULL,              -- set when redeemed (single-use)
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_guardian_login_token_hash (token_hash),
  KEY idx_guardian_login_token_credential (credential_id),
  KEY idx_guardian_login_token_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
