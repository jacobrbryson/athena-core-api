-- =====================================================================
-- 0025_oauth_state.up.sql
-- Short-lived, single-use state for outbound OAuth authorization flows.
-- ---------------------------------------------------------------------
-- The provider's redirect lands on a PUBLIC callback: the browser arrives
-- with no Athena JWT (and the session JWT is IP-pinned, so it could not be
-- relied on anyway). The `state` parameter is therefore the only thing
-- carrying identity across the round trip, which makes it a credential.
--
-- A signed, self-contained state would be replayable for its whole lifetime.
-- Storing it instead — hashed, single-use, minutes-long — makes an
-- authorization-code injection attack a one-shot race rather than a window,
-- and lets the callback prove the flow is one Athena actually started.
--
-- Mirrors the established hashed single-use pattern from child_login_code
-- and guardian_login_token: store sha256, never the value.
-- =====================================================================

CREATE TABLE IF NOT EXISTS oauth_state (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  state_hash    CHAR(64)        NOT NULL,   -- sha256 of the state value
  profile_id    BIGINT          NOT NULL,
  provider      VARCHAR(40)     NOT NULL,
  -- PKCE verifier. Stored in the clear deliberately: it lives for minutes,
  -- is destroyed on use, and is worthless without the matching single-use
  -- authorization code. Encrypting it would enrol a row that expires faster
  -- than the rotation job runs, for no gain.
  code_verifier VARCHAR(128)    NULL,
  -- Where to send the browser once the callback finishes. Validated against
  -- INTEGRATION_REDIRECT_ALLOWLIST when the flow starts, so the callback
  -- cannot be turned into an open redirect.
  redirect_to   VARCHAR(255)    NULL,
  expires_at    DATETIME        NOT NULL,
  consumed_at   DATETIME        NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_oauth_state_hash (state_hash),
  KEY idx_oauth_state_profile (profile_id),
  KEY idx_oauth_state_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
