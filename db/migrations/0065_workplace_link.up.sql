-- =====================================================================
-- 0065_workplace_link.up.sql
-- What belongs to a workplace (owner, 2026-10-13): the connections that
-- are that company's (the Jira site at vivacitytech.atlassian.net is
-- Vivacity's and nobody else's) and the email addresses that are that
-- company's (rbryson@vivacitytech.com, ross@orcwood.com).
--
-- One row per link. kind = 'credential' points at a user_credential row by
-- uuid — metadata only; the token stays encrypted where it is, and nothing
-- here changes how a token is used. kind = 'email' is an address, which
-- need not be a connection at all.
--
-- Exclusive by construction: a connection or an address belongs to at most
-- one of the person's workplaces (the two unique keys; MySQL lets the NULL
-- side of each repeat).
--
-- Conventions match 0001-0064: no enforced FKs (integrity in the service).
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_workplace_link (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid            CHAR(36)        NOT NULL,
  profile_id      BIGINT          NOT NULL,
  workplace_id    BIGINT UNSIGNED NOT NULL,
  kind            VARCHAR(16)     NOT NULL,   -- credential | email
  credential_uuid CHAR(36)        NULL,       -- user_credential.uuid when kind = 'credential'
  email           VARCHAR(190)    NULL,       -- lower-cased, when kind = 'email'
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_workplace_link_uuid (uuid),
  UNIQUE KEY uq_athena_workplace_link_credential (profile_id, credential_uuid),
  UNIQUE KEY uq_athena_workplace_link_email (profile_id, email),
  KEY idx_athena_workplace_link_workplace (workplace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
