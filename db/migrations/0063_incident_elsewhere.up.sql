-- Calls PulsePoint reported that could not be placed on a map, and what was
-- decided about each (owner, 2026-10-12). Most are somewhere else in the
-- county, and a wreck or a medical call there is not worth a push; but a call
-- that is not pushed is still kept here, so "anything going on?" can answer
-- and a quiet day can be told apart from a silenced one. Told calls are
-- recorded too, with why, so every decision is auditable.
CREATE TABLE IF NOT EXISTS athena_incident_elsewhere (
  profile_id BIGINT NOT NULL,
  incident_id VARCHAR(64) NOT NULL,               -- "pu:..." — the same id the nudge carries
  what VARCHAR(100) NOT NULL,
  category VARCHAR(40) NULL,
  address VARCHAR(200) NULL,
  text VARCHAR(300) NOT NULL,                     -- the notification as it arrived
  told TINYINT(1) NOT NULL,                       -- 1 = pushed, 0 = kept quietly
  decided_by VARCHAR(16) NOT NULL,                -- rules | model | failed
  reason VARCHAR(300) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, incident_id),
  KEY idx_elsewhere_recent (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
