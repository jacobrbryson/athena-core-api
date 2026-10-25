DROP TABLE IF EXISTS trading_notification_deliveries;
DROP TABLE IF EXISTS trading_notifications;
DROP TABLE IF EXISTS trading_notification_prefs;

UPDATE trading_alerts SET kind = 'daily_risk' WHERE kind = 'trade_limit';
ALTER TABLE trading_alerts
  MODIFY COLUMN kind ENUM('approaching','entry_confirmed','invalidated','position_stop','position_target','daily_risk','event_soon') NOT NULL;

-- EXPIRED has no older equivalent; the nearest is "ended".
UPDATE trading_signal_events SET to_status = 'EXIT_INVALIDATED' WHERE to_status = 'EXPIRED';
UPDATE trading_signals SET status = 'EXIT_INVALIDATED' WHERE status = 'EXPIRED';
UPDATE trading_signals SET initial_status = 'EXIT_INVALIDATED' WHERE initial_status = 'EXPIRED';
ALTER TABLE trading_signal_events
  MODIFY COLUMN to_status ENUM('WATCH','SETUP_FORMING','ENTRY_CONFIRMED','WAIT','AVOID','EXIT_INVALIDATED') NOT NULL;
ALTER TABLE trading_signals
  DROP KEY idx_signal_expiry,
  DROP COLUMN expiry_policy,
  DROP COLUMN expires_at,
  DROP COLUMN last_evaluated_at,
  DROP COLUMN state_key,
  MODIFY COLUMN status ENUM('WATCH','SETUP_FORMING','ENTRY_CONFIRMED','WAIT','AVOID','EXIT_INVALIDATED') NOT NULL,
  MODIFY COLUMN initial_status ENUM('WATCH','SETUP_FORMING','ENTRY_CONFIRMED','WAIT','AVOID','EXIT_INVALIDATED') NOT NULL;
