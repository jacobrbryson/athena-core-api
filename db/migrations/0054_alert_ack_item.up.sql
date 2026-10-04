-- "Got it" buries an alert forever (owner, 2026-10-04). athena_alert_ack held
-- one key for the whole situation, so the next call made a new key and the
-- banner and chat brought every acknowledged call back with it. This holds
-- each acknowledged item instead: a phone call's id ("ph:...") or a weather
-- alert's ("w:..."). Nothing ever deletes a row here.
CREATE TABLE IF NOT EXISTS athena_alert_ack_item (
  profile_id BIGINT NOT NULL,
  item_id VARCHAR(128) NOT NULL,
  acknowledged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
