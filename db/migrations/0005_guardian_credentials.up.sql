-- =====================================================================
-- 0005_guardian_credentials.up.sql
-- Guardian credentials for the Lake Norman Guardians / Rescue Ratatouille
-- augmented-reality adventure system.
-- ---------------------------------------------------------------------
-- A Guardian authenticates with an 8-digit Guardian ID + a 6-character
-- alpha-numeric Guardian Secret. The secret is never stored in plaintext;
-- only a salted hash (see src/helpers/secret.js) is persisted.
--
-- A Guardian ID represents different things per adventure:
--   * lake_norman_guardians -> an individual child  (participant_type 'guardian')
--   * rescue_ratatouille     -> a shared group       (participant_type 'civilian_group')
-- The participant_type column carries that distinction so the session model
-- can support both cases.
--
-- Conventions match 0001-0004: BIGINT UNSIGNED ids, no enforced FKs
-- (integrity in the service layer), idempotent CREATE TABLE IF NOT EXISTS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- guardian_credential
-- One row per issued Guardian credential.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guardian_credential (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guardian_id          VARCHAR(8)      NOT NULL,            -- exactly 8 numeric digits
  guardian_secret_hash VARCHAR(255)    NOT NULL,            -- salted hash, never plaintext
  display_name         VARCHAR(160)    NULL,
  adventure_key        VARCHAR(60)     NOT NULL,            -- e.g. lake_norman_guardians
  participant_type     VARCHAR(40)     NOT NULL DEFAULT 'guardian', -- guardian | civilian_group
  is_active            TINYINT(1)      NOT NULL DEFAULT 1,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_login_at        DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_guardian_credential_guardian_id (guardian_id),
  KEY idx_guardian_credential_adventure (adventure_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- guardian_login_attempt
-- Audit log of every Guardian login attempt (success or failure). Used
-- for security review and to back rate limiting / lockout decisions.
-- guardian_id is stored as attempted (may not match a real credential).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guardian_login_attempt (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guardian_id VARCHAR(32)     NULL,          -- as attempted (wider than 8 to capture junk input)
  success     TINYINT(1)      NOT NULL,
  ip          VARCHAR(64)     NULL,
  user_agent  VARCHAR(255)    NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_guardian_login_attempt_guardian (guardian_id),
  KEY idx_guardian_login_attempt_created (created_at),
  KEY idx_guardian_login_attempt_ip (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
