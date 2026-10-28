-- =====================================================================
-- 0101_outage_watch.up.sql
-- "Something is down": when several independent things at home go quiet
-- together, Athena works out whether it looks local or widespread, searches
-- for a cause, tells the household once, and says when it's over. Also keeps
-- the camera bridge's own reachability so a silent bridge can't go unseen.
-- See src/services/outage/ and docs/capabilities/outage-watch.md.
--
-- Owner wishlist, 2026-10-28 (after the 2026-10-27 town-wide power cut).
-- Conventions match 0001-0100: no enforced FKs.
-- =====================================================================

-- One row per suspected outage. open_key is 'open' while the episode is live
-- and NULL once closed, so its unique index allows exactly one live episode.
CREATE TABLE IF NOT EXISTS athena_outage_episode (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid                  CHAR(36)        NOT NULL,
  open_key              VARCHAR(8)      NULL,
  state                 VARCHAR(16)     NOT NULL DEFAULT 'open',  -- open | reported | recovered | closed
  opened_at             DATETIME        NOT NULL,                 -- when the first thing went quiet
  signals               JSON            NOT NULL,                 -- what was dark when it was noticed
  checked               JSON            NULL,                     -- every source consulted and what it said (incl. failures)
  locality              VARCHAR(16)     NULL,                     -- local | widespread | unknown
  cause_status          VARCHAR(8)      NULL,                     -- found | none | failed
  cause_text            VARCHAR(400)    NULL,
  cause_sources         JSON            NULL,
  nudge_uuid            CHAR(36)        NULL,
  reported_at           DATETIME        NULL,
  recovered_at          DATETIME        NULL,
  recovery_cause_text   VARCHAR(400)    NULL,
  recovery_nudge_uuid   CHAR(36)        NULL,
  recovery_reported_at  DATETIME        NULL,
  closed_at             DATETIME        NULL,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_outage_episode_uuid (uuid),
  UNIQUE KEY uq_athena_outage_episode_open (open_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per assessment pass, including the quiet ones and the ones whose
-- checks failed, so "nothing was wrong" and "I couldn't look" differ in the data.
CREATE TABLE IF NOT EXISTS athena_outage_assessment (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  at          DATETIME        NOT NULL,
  reason      VARCHAR(40)     NOT NULL,        -- nest_offline | backstop | manual
  verdict     VARCHAR(16)     NOT NULL,        -- quiet | suspected | ongoing | recovered | check_failed
  episode_id  BIGINT UNSIGNED NULL,
  signals     JSON            NULL,
  errors      JSON            NULL,
  PRIMARY KEY (id),
  KEY idx_athena_outage_assessment_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The camera bridge's reachability from core (single row, id = 1).
CREATE TABLE IF NOT EXISTS athena_camera_bridge_health (
  id                 TINYINT UNSIGNED NOT NULL,
  state              VARCHAR(24)      NOT NULL DEFAULT 'unknown',  -- ready | unreachable | <bridge state, e.g. authorization_required>
  since              DATETIME         NULL,                        -- when it entered a non-ready state
  last_ok_at         DATETIME         NULL,
  last_checked_at    DATETIME         NULL,
  reported_since     DATETIME         NULL,                        -- the `since` already told to the household
  recovery_pending   TINYINT(1)       NOT NULL DEFAULT 0,          -- told it was down, "back" note not yet sent
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO athena_camera_bridge_health (id) VALUES (1);
