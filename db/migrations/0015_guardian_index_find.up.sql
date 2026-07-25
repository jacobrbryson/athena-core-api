-- Mission 3 "The First Watch": the shared index of found cards.
--
-- Unlike guardian_trail_key (Mission 1, per-guardian and strictly ordered),
-- this index belongs to the NETWORK. The primary key is (mission, adventure,
-- code) with no guardian_id in it, so a card can only ever be found once and
-- every Guardian's index advances together the moment anyone reports a code.
-- `found_by_guardian_id` is kept so Athena can credit the finder by name, but
-- it deliberately does NOT gate anything.

CREATE TABLE IF NOT EXISTS guardian_index_find (
  mission_key          VARCHAR(80) NOT NULL,
  adventure_key        VARCHAR(80) NOT NULL,
  code                 VARCHAR(16) NOT NULL,
  entry_id             VARCHAR(16) NOT NULL,
  found_by_guardian_id VARCHAR(8)  NOT NULL,
  found_at             DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (mission_key, adventure_key, code),
  KEY idx_index_find_adventure (mission_key, adventure_key, found_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which synthesis beats have already fired for this adventure. Also
-- network-scoped: a convergence fires once for everyone, not once per player,
-- so Athena never re-delivers the same realisation to a second Guardian.

CREATE TABLE IF NOT EXISTS guardian_index_convergence (
  mission_key    VARCHAR(80) NOT NULL,
  adventure_key  VARCHAR(80) NOT NULL,
  convergence_id VARCHAR(40) NOT NULL,
  fired_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (mission_key, adventure_key, convergence_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
