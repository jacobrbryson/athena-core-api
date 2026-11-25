-- =====================================================================
-- 0128_gm_relay_runs.up.sql
-- Signal Relay (owner, 2026-11-24): the kids' Morse-code game for when the
-- network goes down on a road trip, or when they're bored. It runs entirely
-- on the tablet; a finished run (every message sent, link restored) is kept
-- there and posted here once Base answers again. Each row is one run.
-- ---------------------------------------------------------------------
--   actor_id     — the kid's own athena_gm_actor (kind 'kid'). Plain id, no
--                  FK, matching athena_gm_badge_award.
--   client_id    — the id the tablet gave the run, so a run sent twice (a
--                  retry after a dropped reply) is recorded once.
--   finished_at  — when the kid finished it, from the tablet, clamped to
--                  the last 30 days and never the future.
--   messages     — how many messages the run asked for (5 today).
--   wpm          — their keying speed at the end, for the record only.
--
-- Points: team.js counts at most RELAY_RUNS_PER_DAY runs per kid per day.
-- Conventions match 0001-0127.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_gm_relay_run (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id BIGINT UNSIGNED NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  finished_at DATETIME NOT NULL,
  messages TINYINT UNSIGNED NOT NULL DEFAULT 0,
  wpm TINYINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_relay_client (actor_id, client_id),
  KEY ix_gm_relay_actor_day (actor_id, finished_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
