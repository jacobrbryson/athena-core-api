-- =====================================================================
-- 0081_keep_item_history.up.sql
-- When grocery items were bought — which Google Keep never records (every
-- list item comes back stamped 1970-01-01). Athena works it out herself: each
-- fresh read of a Keep list is compared with the last one she saw, and a tick
-- (unticked -> ticked) is recorded as 'bought', an untick as 'needed'.
-- See src/services/connectors/googleKeep.js and docs/capabilities/google-keep.md.
--
-- observed_at is when Athena NOTICED the change (the read that saw it), not
-- when the shopping happened: reads happen when dinner or groceries come up,
-- plus one nightly backstop, so a change can be up to a day old when seen.
--
-- athena_keep_snapshot is one row per (profile, list): the last state seen,
-- as a JSON object of item_key -> { t: text, c: 0|1 }. The first read of a
-- list writes only this row (the baseline) and no events.
--
-- item_key is the item's text lower-cased with whitespace collapsed, so
-- "Eggs " and "eggs" are the same item.
--
-- Conventions match 0001-0080: no enforced FKs.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_keep_snapshot (
  profile_id  BIGINT          NOT NULL,
  list_id     VARCHAR(64)     NOT NULL,  -- Keep's node id for the list
  items       JSON            NOT NULL,
  taken_at    DATETIME(3)     NOT NULL,
  PRIMARY KEY (profile_id, list_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_keep_item_event (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id  BIGINT          NOT NULL,
  list_id     VARCHAR(64)     NOT NULL,
  item_key    VARCHAR(255)    NOT NULL,  -- normalized text
  item_text   VARCHAR(255)    NOT NULL,  -- as written on the list, for display
  event       VARCHAR(8)      NOT NULL,  -- bought | needed
  observed_at DATETIME(3)     NOT NULL,  -- when Athena noticed, not when it happened
  PRIMARY KEY (id),
  KEY idx_athena_keep_item_event_recent (profile_id, list_id, observed_at),
  KEY idx_athena_keep_item_event_item (profile_id, list_id, item_key, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
