-- =====================================================================
-- 0129_relay_messages.up.sql
-- Secret messages in Signal Relay (owner, 2026-11-25): "The kids also want to
-- be able to send each other secret messages on the Morse code game." Any
-- person with Athena access can send one to any other (owner: "any other
-- person with an athena account"), and every message is logged (owner: "Log
-- everything, but parents don't need access right now"). A kid taps it in
-- Morse; the other person decodes it, letter by letter, in the game.
-- ---------------------------------------------------------------------
--   uuid           — public id the tablet and the inbox use.
--   from_profile_id / to_profile_id — profile.id of sender and recipient.
--   client_id      — the id the sending tablet gave it, so a send retried
--                    after a dropped reply (or queued offline and sent twice)
--                    is logged once.
--   body           — the message, A–Z, 0–9 and spaces only, at most 30.
--   tapped_at      — when it was tapped on the tablet (may be offline),
--                    clamped to the last 30 days and never the future.
--   delivered_at   — first time the recipient's game fetched it.
--   decoded_at     — when the recipient finished decoding it.
--   created_at     — when the server received it.
--
-- This table is the log: nothing in the app deletes or edits a row except
-- setting delivered_at / decoded_at once. No parent view reads it yet.
-- Conventions match 0001-0128.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_relay_message (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  from_profile_id BIGINT UNSIGNED NOT NULL,
  to_profile_id BIGINT UNSIGNED NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  body VARCHAR(30) NOT NULL,
  tapped_at DATETIME NOT NULL,
  delivered_at DATETIME NULL,
  decoded_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_relay_msg_uuid (uuid),
  UNIQUE KEY uq_relay_msg_client (from_profile_id, client_id),
  KEY ix_relay_msg_inbox (to_profile_id, decoded_at, created_at),
  KEY ix_relay_msg_sender_day (from_profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
