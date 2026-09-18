-- =====================================================================
-- 0028_device_push.up.sql
-- Reaching a paired phone when Athena is not already on screen.
-- ---------------------------------------------------------------------
-- Initiative (0027) could only speak where the person could already see
-- her: the companion polls, so a nudge sat waiting until someone opened
-- the app, and expired if it went stale first. That is the difference
-- between an assistant and a page you have to check.
--
-- The push registration lives ON `paired_device` rather than in its own
-- table, for one reason that matters more than the tidiness of a join:
-- revoking a device must revoke its ability to buzz your phone, and if
-- those are the same row that is true by construction rather than by
-- remembering to cascade.
--
-- `push_token_enc` is encrypted with the same rotating keyring as the
-- OAuth tokens in `user_credential`, and registered in ENCRYPTED_COLUMNS
-- in src/jobs/rotate-keys.js. An FCM registration token is not a
-- credential Athena uses, but anyone holding it can put a notification
-- on that person's lock screen, which is exactly the kind of capability
-- worth encrypting at rest.
-- =====================================================================

-- Where to reach this device, and how well that has been going.
ALTER TABLE paired_device
  ADD COLUMN push_provider      VARCHAR(16)  NULL AFTER capabilities,
  ADD COLUMN push_token_enc     TEXT         NULL AFTER push_provider,
  ADD COLUMN push_registered_at DATETIME     NULL AFTER push_token_enc,
  -- Consecutive hard failures. FCM tells us when a registration is dead
  -- (the app was uninstalled, the token rotated); the token is cleared on
  -- the first of those rather than retried, and this counter exists for
  -- the soft failures that are worth noticing but not acting on.
  ADD COLUMN push_failures      SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER push_registered_at,
  ADD COLUMN push_failed_at     DATETIME     NULL AFTER push_failures;

-- Whether a nudge ever left the building, as opposed to being fetched.
-- Kept separate from `delivered_at` on purpose: delivered means a client
-- asked for it, pushed means we handed it to a transport. Collapsing the
-- two would let a push that FCM accepted and the phone dropped count as
-- something a person saw.
ALTER TABLE athena_nudge
  ADD COLUMN pushed_at DATETIME NULL AFTER delivered_at;

-- Push is its own opt-in, separate from initiative being on at all.
-- Agreeing that Athena may start a conversation in an app you have open
-- is not the same as agreeing she may light up your phone, and one
-- switch for both would collect consent nobody actually gave.
ALTER TABLE athena_initiative_pref
  ADD COLUMN push_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER enabled;
