-- =====================================================================
-- 0098_trading_notifications.up.sql
-- Push notifications for trading setups (docs/architecture/trading.md,
-- "Notifications"; docs/capabilities/trading.md).
--
-- Notifications are derived from the persisted signal event log, never from a
-- model and never straight from an in-memory evaluation: a row here exists
-- because a row in trading_signal_events (or a daily-risk alert) does. The
-- dedupe key makes a second derivation of the same occurrence a no-op, so a
-- worker restart, a dashboard poll and the monitor tick can all derive at once
-- without a duplicate. Every row is scoped to one profile.
--
-- Devices and subscriptions are NOT here: they are paired_device rows (one
-- per phone/browser, provider, failure counters), shared with the rest of
-- Athena's push. Conventions match 0001-0097: no enforced FK to profile.
-- =====================================================================

-- Lifecycle: an explicit expiry per signal, the policy that set it, the last
-- time it was evaluated at all (last_event_at only moves on a change), and a
-- terminal EXPIRED status. state_key separates a WAIT where every condition
-- passes but the feed can't confirm (a paper setup) from any other WAIT.
ALTER TABLE trading_signals
  MODIFY COLUMN initial_status ENUM('WATCH','SETUP_FORMING','ENTRY_CONFIRMED','WAIT','AVOID','EXIT_INVALIDATED','EXPIRED') NOT NULL,
  MODIFY COLUMN status ENUM('WATCH','SETUP_FORMING','ENTRY_CONFIRMED','WAIT','AVOID','EXIT_INVALIDATED','EXPIRED') NOT NULL,
  ADD COLUMN state_key VARCHAR(40) NULL AFTER status,
  ADD COLUMN last_evaluated_at DATETIME(3) NULL AFTER last_event_at,
  ADD COLUMN expires_at DATETIME(3) NULL AFTER last_evaluated_at,
  ADD COLUMN expiry_policy VARCHAR(120) NULL AFTER expires_at,
  ADD KEY idx_signal_expiry (status, expires_at);

ALTER TABLE trading_signal_events
  MODIFY COLUMN to_status ENUM('WATCH','SETUP_FORMING','ENTRY_CONFIRMED','WAIT','AVOID','EXIT_INVALIDATED','EXPIRED') NOT NULL;

-- A trade-count limit is a risk limit too.
ALTER TABLE trading_alerts
  MODIFY COLUMN kind ENUM('approaching','entry_confirmed','invalidated','position_stop','position_target','daily_risk','event_soon','trade_limit') NOT NULL;

-- What the person wants pushed. No row = nothing is pushed (opt-in).
CREATE TABLE IF NOT EXISTS trading_notification_prefs (
  profile_id BIGINT NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  setup_forming TINYINT(1) NOT NULL DEFAULT 1,
  entry_confirmed TINYINT(1) NOT NULL DEFAULT 1,
  invalidation TINYINT(1) NOT NULL DEFAULT 1,
  paper TINYINT(1) NOT NULL DEFAULT 1,
  risk_limit TINYINT(1) NOT NULL DEFAULT 1,
  sound ENUM('default','silent') NOT NULL DEFAULT 'default',
  -- Minimum gap between low-priority pushes (forming, paper). A push inside
  -- the gap is HELD to the end of it and re-checked, never dropped unseen;
  -- live confirmations, invalidations, expiries and risk limits ignore it.
  cooldown_min SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  -- Strategy keys the person has switched on for LIVE alerts. A version must
  -- also be validated; until then its alerts are paper.
  live_strategies JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The outbox. One row per notifiable occurrence; the worker claims rows by
-- state, re-validates, sends, and records the outcome. A row is never deleted
-- for being undeliverable: it ends 'lapsed' or 'skipped' with the reason.
CREATE TABLE IF NOT EXISTS trading_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  signal_id BIGINT UNSIGNED NULL,
  -- The trading_signal_events.seq (or trading_alerts.id) it was derived from.
  source_seq INT UNSIGNED NULL,
  source_alert_id BIGINT UNSIGNED NULL,
  event ENUM('SETUP_FORMING','ENTRY_CONFIRMED','SETUP_INVALIDATED','SETUP_EXPIRED','RISK_LIMIT_REACHED','TEST') NOT NULL,
  -- live = validated strategy, enabled for live alerts, full-market feed.
  -- Everything else is paper / experimental and says so on the lock screen.
  mode ENUM('live','paper') NOT NULL,
  priority ENUM('high','normal','low') NOT NULL,
  dedupe_key VARCHAR(160) NOT NULL,
  symbol VARCHAR(12) NULL,
  -- Figures copied from the persisted event (entry, stop, target, shares,
  -- cost, risk, R, timestamps). Title and body are rendered from these.
  payload_json JSON NOT NULL,
  title VARCHAR(160) NULL,
  body VARCHAR(500) NULL,
  deep_link VARCHAR(300) NULL,
  state ENUM('pending','held','sending','sent','failed','lapsed','skipped') NOT NULL DEFAULT 'pending',
  state_reason VARCHAR(300) NULL,
  not_before DATETIME(3) NULL,
  expires_at DATETIME(3) NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  claimed_at DATETIME(3) NULL,
  claim_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at DATETIME(3) NULL,
  acknowledged_at DATETIME(3) NULL,
  acknowledged_via VARCHAR(20) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_trading_notification_uuid (uuid),
  UNIQUE KEY uq_trading_notification_dedupe (profile_id, dedupe_key),
  KEY idx_trading_notification_due (state, not_before),
  KEY idx_trading_notification_recent (profile_id, created_at),
  KEY idx_trading_notification_signal (signal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every attempt, per device: what the transport said.
CREATE TABLE IF NOT EXISTS trading_notification_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  notification_id BIGINT UNSIGNED NOT NULL,
  attempt TINYINT UNSIGNED NOT NULL,
  device_uuid CHAR(36) NULL,
  device_name VARCHAR(80) NULL,
  platform VARCHAR(16) NULL,
  ok TINYINT(1) NOT NULL,
  reason VARCHAR(160) NULL,
  attempted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_trading_delivery_notification (notification_id),
  CONSTRAINT fk_trading_delivery_notification FOREIGN KEY (notification_id) REFERENCES trading_notifications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
