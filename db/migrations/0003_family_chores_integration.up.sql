-- =====================================================================
-- 0003_family_chores_integration.up.sql
-- External app integrations (starting with the Family Chores app).
-- ---------------------------------------------------------------------
-- Lets an Athena user link a third-party account so Athena can answer
-- questions backed by that app's data ("what chores do I have today?",
-- "how many coins do I have?"). The first provider is `family_chores`,
-- but the tables are provider-generic so future integrations reuse them.
--
-- Two tables, mirroring the established child-login-code pattern:
--   * integration_link_code -- short-lived, single-use codes an Athena
--     user generates to authorize a "one click" connect from the other
--     app's backend (analogous to child_login_code).
--   * integration_link -- the durable connection: the external identity
--     plus the (encrypted) API token Athena uses to read that app's data.
--
-- Conventions match 0001/0002: BIGINT UNSIGNED ids, no enforced FKs
-- (integrity in the service layer), idempotent CREATE TABLE IF NOT EXISTS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- integration_link_code
-- A logged-in Athena user mints one of these; the partner app's backend
-- redeems it (with its own API token) to establish the link. Single use
-- (consumed_at) and short-lived (expires_at).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_link_code (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid         CHAR(36)        NOT NULL,
  provider     VARCHAR(40)     NOT NULL DEFAULT 'family_chores',
  code         VARCHAR(120)    NOT NULL,
  profile_id   BIGINT          NOT NULL,
  family_id    BIGINT UNSIGNED NULL,
  expires_at   DATETIME        NULL,
  consumed_at  DATETIME        NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_integration_link_code_uuid (uuid),
  UNIQUE KEY uq_integration_link_code_code (code),
  KEY idx_integration_link_code_profile (profile_id),
  KEY idx_integration_link_code_provider (provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- integration_link
-- The durable connection between an Athena profile and an external app
-- account. One active link per (profile, provider); re-connecting
-- overwrites it (handled in the service with an upsert).
--
-- access_token holds the partner API token ENCRYPTED at rest
-- (AES-256-GCM, see src/helpers/crypto.js). Never store it in plaintext.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_link (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid               CHAR(36)        NOT NULL,
  provider           VARCHAR(40)     NOT NULL DEFAULT 'family_chores',
  profile_id         BIGINT          NOT NULL,
  family_id          BIGINT UNSIGNED NULL,
  external_user_id   VARCHAR(120)    NULL,
  external_player_id VARCHAR(120)    NULL,
  external_family_id VARCHAR(120)    NULL,
  display_name       VARCHAR(160)    NULL,
  access_token       TEXT            NOT NULL,          -- encrypted (AES-256-GCM)
  base_url           VARCHAR(255)    NULL,
  scopes             VARCHAR(255)    NULL,
  status             VARCHAR(20)     NOT NULL DEFAULT 'active',
  last_synced_at     DATETIME        NULL,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at         DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_integration_link_uuid (uuid),
  UNIQUE KEY uq_integration_link_profile_provider (profile_id, provider),
  KEY idx_integration_link_provider (provider),
  KEY idx_integration_link_family (family_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
