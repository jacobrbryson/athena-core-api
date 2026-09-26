-- "Got it" on the alert banner, remembered per person in the database rather
-- than in one browser's localStorage, so it holds across the phone, the web
-- app and a cleared cache. `alert_key` identifies what was acknowledged (the
-- situation's incident_key, or "model:<headline>"); a new development has a
-- new key and so shows again.
CREATE TABLE IF NOT EXISTS athena_alert_ack (
  profile_id BIGINT NOT NULL,
  alert_key VARCHAR(255) NOT NULL,
  acknowledged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The PulsePoint web board is no longer read (owner, 2026-09-26): 911 calls
-- arrive from the phone's PulsePoint notifications instead. Its health row
-- would otherwise report a block forever.
DELETE FROM athena_incident_source WHERE source = 'pulsepoint';
