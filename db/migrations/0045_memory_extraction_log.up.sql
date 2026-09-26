-- =====================================================================
-- 0045_memory_extraction_log.up.sql
-- What each memory extraction proposed, and why each proposal was or wasn't
-- written.
-- ---------------------------------------------------------------------
-- From 2026-09-20, extraction wrote almost nothing, and nothing could say
-- whether the extractor was broken or there was just nothing new to
-- remember. llm_call_log showed the model returning content, yet the only
-- surviving number was "0 facts". Most extractions run on the chat path
-- (afterTurn), not in the nightly sweep, so the sweep's own totals can't
-- answer it either. One row per extraction, from either path, does.
--
-- Counts only, never content: it is written for child profiles too.
-- =====================================================================

CREATE TABLE IF NOT EXISTS memory_extraction_log (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_id              BIGINT NOT NULL,
  profile_id              BIGINT NOT NULL,
  -- 'turn' (after a chat reply) or 'nightly' (the catch-up sweep)
  source                  VARCHAR(12) NOT NULL,
  human_lines             INT UNSIGNED NOT NULL DEFAULT 0,
  proposed_facts          INT UNSIGNED NOT NULL DEFAULT 0,
  proposed_moments        INT UNSIGNED NOT NULL DEFAULT 0,
  written_facts           INT UNSIGNED NOT NULL DEFAULT 0,
  written_moments         INT UNSIGNED NOT NULL DEFAULT 0,
  forgotten               INT UNSIGNED NOT NULL DEFAULT 0,
  -- Why proposals didn't become memories
  dropped_duplicate       INT UNSIGNED NOT NULL DEFAULT 0, -- known fact, same value
  dropped_low_confidence  INT UNSIGNED NOT NULL DEFAULT 0, -- confidence < 50
  dropped_locked          INT UNSIGNED NOT NULL DEFAULT 0, -- parent-curated / user-entered slot
  dropped_malformed       INT UNSIGNED NOT NULL DEFAULT 0,
  dropped_over_cap        INT UNSIGNED NOT NULL DEFAULT 0, -- past the per-extraction limits
  PRIMARY KEY (id),
  KEY idx_extraction_log_time (created_at),
  KEY idx_extraction_log_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
