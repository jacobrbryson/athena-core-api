-- Nearby emergencies, as a SITUATION rather than a stream of calls.
--
-- athena_incident_situation: one row per watched profile, rewritten by the
-- athena-incidents job whenever the set of nearby calls changes. It holds the
-- model's assessment (how serious, what to say) so every surface — the in-app
-- banner, Athena's chat prompt, the push/text — reads the same judgement
-- without a live PulsePoint fetch or a model call on the request path.
CREATE TABLE IF NOT EXISTS athena_incident_situation (
  profile_id BIGINT NOT NULL,
  level VARCHAR(16) NOT NULL DEFAULT 'none',        -- none | watch | urgent
  headline VARCHAR(200) NULL,
  body VARCHAR(1000) NULL,
  incidents JSON NULL,                              -- the nearby active calls, nearest first
  incident_key CHAR(40) NULL,                       -- sha1 of the sorted ids, to detect change
  assessed_by VARCHAR(64) NULL,                     -- model id, or 'rules' when the model was unavailable
  started_at DATETIME NULL,                         -- when the current non-none situation began
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Is the feed itself alive? A single row (id = 1). An emergency watcher that
-- quietly stops reading is worse than none, because it is trusted.
CREATE TABLE IF NOT EXISTS athena_incident_feed (
  id TINYINT UNSIGNED NOT NULL,
  last_ok_at DATETIME NULL,
  last_error VARCHAR(500) NULL,
  consecutive_failures INT UNSIGNED NOT NULL DEFAULT 0,
  outage_notified_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO athena_incident_feed (id) VALUES (1);
