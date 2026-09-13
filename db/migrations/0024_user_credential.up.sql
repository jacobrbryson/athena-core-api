-- =====================================================================
-- 0024_user_credential.up.sql
-- Per-user credentials for third-party integrations.
-- ---------------------------------------------------------------------
-- Where `integration_link` (0003) models a partner-initiated link to one
-- specific app (Family Chores), this is the generic store for credentials
-- an Athena user grants directly: Google Calendar, Strava, Whoop, and any
-- API key a user brings themselves.
--
-- These live in MySQL rather than Secret Manager on purpose. OAuth access
-- tokens expire in about an hour (Google, Whoop) to six (Strava), so every
-- refresh would mint a Secret Manager version to bill for and later destroy,
-- and per-secret IAM buys nothing when one service account reads all of
-- them. They are encrypted at rest instead, under the rotating keyring in
-- src/helpers/crypto.js. See docs/architecture/secret-rotation.md.
--
-- Conventions match 0001-0023: BIGINT UNSIGNED ids, no enforced FKs
-- (integrity in the service layer), idempotent CREATE TABLE IF NOT EXISTS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- user_credential
-- One row per (profile, provider, external account). Re-connecting the
-- same account overwrites the row, including reviving a revoked one —
-- handled by an upsert in src/services/credentials.js.
--
-- access_token_enc / refresh_token_enc hold ciphertext ONLY (AES-256-GCM,
-- see src/helpers/crypto.js). The ciphertext names the keyring key that
-- wrote it, so rotation needs no extra bookkeeping column here — but both
-- columns MUST be listed in ENCRYPTED_COLUMNS in src/jobs/rotate-keys.js
-- or rotation will leave them behind on a retired key.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_credential (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid                CHAR(36)        NOT NULL,
  profile_id          BIGINT          NOT NULL,
  provider            VARCHAR(40)     NOT NULL,                    -- google_calendar | strava | whoop | openai
  kind                VARCHAR(16)     NOT NULL DEFAULT 'oauth2',   -- oauth2 | api_key
  -- The provider's own id for the account. '' (not NULL) when the provider
  -- has no notion of one, so the unique key below still applies: MySQL
  -- treats NULLs as distinct and would allow duplicate links.
  external_account_id VARCHAR(190)    NOT NULL DEFAULT '',
  display_name        VARCHAR(160)    NULL,
  access_token_enc    TEXT            NULL,                        -- encrypted; NULL once revoked
  refresh_token_enc   TEXT            NULL,                        -- encrypted; NULL when non-refreshable
  token_type          VARCHAR(32)     NULL,
  scopes              TEXT            NULL,                        -- space-separated, as the provider returned them
  expires_at          DATETIME        NULL,                        -- access-token expiry; NULL = does not expire
  status              VARCHAR(20)     NOT NULL DEFAULT 'active',   -- active | needs_reauth | revoked
  last_refreshed_at   DATETIME        NULL,
  last_used_at        DATETIME        NULL,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  revoked_at          DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_credential_uuid (uuid),
  UNIQUE KEY uq_user_credential_account (profile_id, provider, external_account_id),
  KEY idx_user_credential_profile (profile_id),
  KEY idx_user_credential_provider (provider),
  KEY idx_user_credential_status (status),
  KEY idx_user_credential_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- user_credential_audit
-- Append-only. Athena holding a Guardian's health and calendar tokens is
-- exactly the kind of power the mission says must be accountable, so every
-- link, read, refresh and revoke is recorded. Rows outlive the credential
-- (credential_id goes NULL, profile_id and provider stay) so revoking does
-- not erase the history of what was done with it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_credential_audit (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  credential_id BIGINT UNSIGNED NULL,
  profile_id    BIGINT          NOT NULL,
  provider      VARCHAR(40)     NOT NULL,
  action        VARCHAR(24)     NOT NULL,   -- linked | read | refreshed | revoked | reauth_required | failed
  actor         VARCHAR(120)    NULL,       -- what caused it: 'user', a job name, a tool name
  detail        VARCHAR(255)    NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_credential_audit_cred (credential_id),
  KEY idx_user_credential_audit_profile (profile_id, created_at),
  KEY idx_user_credential_audit_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
