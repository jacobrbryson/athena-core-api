-- Day-trading intelligence (docs/capabilities/trading.md,
-- docs/architecture/trading.md). Athena evaluates intraday setups and keeps an
-- auditable record of what she saw and why she classified it; she never places
-- an order. Every money/price column is fixed-point DECIMAL, every timestamp is
-- UTC, and session dates are America/New_York calendar dates.
--
-- Three things are kept apart on purpose: backtests (trading_backtest_runs),
-- paper trades and real trades (trading_positions.mode). Assessments are
-- append-only (trading_signal_events); a signal row's status is only a pointer
-- to its latest event, and outcome columns are filled in later without
-- touching the assessment that preceded them.

-- One per person for now: the settings that bound every recommendation.
CREATE TABLE IF NOT EXISTS trading_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  broker VARCHAR(20) NOT NULL DEFAULT 'webull',
  account_type ENUM('cash') NOT NULL DEFAULT 'cash',
  starting_capital DECIMAL(14,2) NOT NULL,
  max_risk_per_trade DECIMAL(10,2) NOT NULL,
  max_daily_loss DECIMAL(10,2) NOT NULL,
  max_trades_per_day TINYINT UNSIGNED NOT NULL,
  min_reward_risk DECIMAL(6,2) NOT NULL,
  allow_fractional TINYINT(1) NOT NULL DEFAULT 0,
  -- Cost model used in every sizing and every backtest.
  commission_per_order DECIMAL(10,4) NOT NULL DEFAULT 0,
  sec_fee_rate DECIMAL(12,10) NOT NULL DEFAULT 0.0000278,
  taf_fee_per_share DECIMAL(10,6) NOT NULL DEFAULT 0.000166,
  slippage_per_share DECIMAL(10,4) NOT NULL DEFAULT 0.0100,
  alerts_enabled TINYINT(1) NOT NULL DEFAULT 1,
  -- Last reconciliation against the broker's own figures.
  broker_cash DECIMAL(14,2) NULL,
  broker_settled_cash DECIMAL(14,2) NULL,
  broker_checked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_trading_account_uuid (uuid),
  UNIQUE KEY uq_trading_account_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cash movements, each with the date it settles. Settled cash on a day is the
-- sum of entries settled by then; unsettled proceeds are the rest. Deposits,
-- withdrawals, executions and reconciliation adjustments stay distinguishable.
CREATE TABLE IF NOT EXISTS trading_cash_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('opening','deposit','withdrawal','buy','sell','fee','adjustment') NOT NULL,
  amount DECIMAL(14,4) NOT NULL,
  trade_date DATE NOT NULL,
  settles_on DATE NOT NULL,
  position_id BIGINT UNSIGNED NULL,
  note VARCHAR(200) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ledger_account (account_id, settles_on),
  KEY idx_ledger_position (position_id),
  CONSTRAINT fk_ledger_account FOREIGN KEY (account_id) REFERENCES trading_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Strategy definitions. A parameter change is a new version, never an edit, so
-- every signal and backtest names exactly the rules it ran under.
CREATE TABLE IF NOT EXISTS trading_strategy_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  strategy_key VARCHAR(40) NOT NULL,
  version INT UNSIGNED NOT NULL,
  params_json JSON NOT NULL,
  params_hash CHAR(64) NOT NULL,
  description VARCHAR(300) NULL,
  -- 'validated' needs out-of-sample backtest and paper evidence; only then do
  -- ENTRY CONFIRMED alerts go out as live alerts.
  status ENUM('draft','paper','validated','retired') NOT NULL DEFAULT 'paper',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_strategy_version (strategy_key, version),
  UNIQUE KEY uq_strategy_hash (strategy_key, params_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The day's ranked list, with the scanner's reasons as they stood.
CREATE TABLE IF NOT EXISTS trading_watchlists (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id BIGINT NOT NULL,
  session_date DATE NOT NULL,
  symbol VARCHAR(12) NOT NULL,
  company_name VARCHAR(160) NULL,
  `rank` SMALLINT UNSIGNED NULL,
  scanner_score DECIMAL(8,3) NULL,
  reasons_json JSON NULL,
  source ENUM('scanner','manual') NOT NULL DEFAULT 'scanner',
  pinned TINYINT(1) NOT NULL DEFAULT 0,
  added_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  removed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_watch_day_symbol (profile_id, session_date, symbol),
  KEY idx_watch_day (profile_id, session_date, `rank`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Closed candles kept for reproducible evaluation and replay — not every tick.
-- Retention (services/trading/retention.js): 1-minute bars of symbols with a
-- signal are kept long; everything else ages out.
CREATE TABLE IF NOT EXISTS trading_candles (
  symbol VARCHAR(12) NOT NULL,
  timeframe ENUM('1Min','5Min') NOT NULL,
  feed VARCHAR(12) NOT NULL,
  bar_start DATETIME(3) NOT NULL,
  open DECIMAL(14,4) NOT NULL,
  high DECIMAL(14,4) NOT NULL,
  low DECIMAL(14,4) NOT NULL,
  close DECIMAL(14,4) NOT NULL,
  volume BIGINT UNSIGNED NOT NULL,
  vwap DECIMAL(14,4) NULL,
  trade_count INT UNSIGNED NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (symbol, timeframe, feed, bar_start),
  KEY idx_candles_age (bar_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What the market and each symbol looked like at evaluation time.
CREATE TABLE IF NOT EXISTS trading_market_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id BIGINT NULL,
  session_date DATE NOT NULL,
  kind ENUM('market','symbol') NOT NULL,
  symbol VARCHAR(12) NULL,
  taken_at DATETIME(3) NOT NULL,
  data_source VARCHAR(40) NOT NULL,
  feed VARCHAR(12) NOT NULL,
  quote_at DATETIME(3) NULL,
  last_bar_at DATETIME(3) NULL,
  is_stale TINYINT(1) NOT NULL,
  market_phase VARCHAR(20) NOT NULL,
  regime VARCHAR(20) NULL,
  assessment VARCHAR(20) NULL,
  payload_json JSON NOT NULL,
  PRIMARY KEY (id),
  KEY idx_snap_day (session_date, kind, symbol, taken_at),
  KEY idx_snap_age (taken_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One setup per person, day, symbol and strategy version, rejected ones too.
-- The initial_* columns are written once. status/last_* point at the newest
-- event. outcome_* are measured after the fact from later candles.
CREATE TABLE IF NOT EXISTS trading_signals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  session_date DATE NOT NULL,
  symbol VARCHAR(12) NOT NULL,
  strategy_version_id BIGINT UNSIGNED NOT NULL,
  data_source VARCHAR(40) NOT NULL,
  feed VARCHAR(12) NOT NULL,
  initial_status ENUM('WATCH','SETUP_FORMING','ENTRY_CONFIRMED','WAIT','AVOID','EXIT_INVALIDATED') NOT NULL,
  initial_at DATETIME(3) NOT NULL,
  status ENUM('WATCH','SETUP_FORMING','ENTRY_CONFIRMED','WAIT','AVOID','EXIT_INVALIDATED') NOT NULL,
  last_event_at DATETIME(3) NOT NULL,
  ever_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  confirmed_at DATETIME(3) NULL,
  confirmed_entry DECIMAL(14,4) NULL,
  confirmed_stop DECIMAL(14,4) NULL,
  confirmed_target DECIMAL(14,4) NULL,
  -- Hypothetical outcome, from candles after the decision (outcomes.js).
  outcome ENUM('target_first','stop_first','neither','no_trigger') NULL,
  outcome_r DECIMAL(8,3) NULL,
  outcome_mfe_r DECIMAL(8,3) NULL,
  outcome_mae_r DECIMAL(8,3) NULL,
  outcome_measured_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_signal_uuid (uuid),
  UNIQUE KEY uq_signal_day (profile_id, session_date, symbol, strategy_version_id),
  KEY idx_signal_status (profile_id, session_date, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only: each change of status with everything that produced it.
CREATE TABLE IF NOT EXISTS trading_signal_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  signal_id BIGINT UNSIGNED NOT NULL,
  seq INT UNSIGNED NOT NULL,
  evaluated_at DATETIME(3) NOT NULL,
  last_bar_at DATETIME(3) NULL,
  quote_at DATETIME(3) NULL,
  from_status VARCHAR(20) NULL,
  to_status ENUM('WATCH','SETUP_FORMING','ENTRY_CONFIRMED','WAIT','AVOID','EXIT_INVALIDATED') NOT NULL,
  reason VARCHAR(300) NOT NULL,
  conditions_json JSON NOT NULL,
  indicators_json JSON NOT NULL,
  levels_json JSON NULL,
  sizing_json JSON NULL,
  snapshot_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_signal_seq (signal_id, seq),
  KEY idx_event_time (evaluated_at),
  CONSTRAINT fk_event_signal FOREIGN KEY (signal_id) REFERENCES trading_signals (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Positions the person recorded (live) or the forward test opened (paper).
-- Nothing here is an order: a live row exists only because the person said so.
CREATE TABLE IF NOT EXISTS trading_positions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  mode ENUM('live','paper') NOT NULL,
  signal_id BIGINT UNSIGNED NULL,
  strategy_version_id BIGINT UNSIGNED NULL,
  symbol VARCHAR(12) NOT NULL,
  setup_type VARCHAR(40) NOT NULL DEFAULT 'orb_vwap',
  shares DECIMAL(16,6) NOT NULL,
  entry_price DECIMAL(14,4) NOT NULL,
  entry_at DATETIME(3) NOT NULL,
  planned_entry DECIMAL(14,4) NULL,
  planned_stop DECIMAL(14,4) NOT NULL,
  planned_target DECIMAL(14,4) NULL,
  entry_fees DECIMAL(10,4) NOT NULL DEFAULT 0,
  exit_price DECIMAL(14,4) NULL,
  exit_at DATETIME(3) NULL,
  exit_fees DECIMAL(10,4) NULL,
  exit_reason ENUM('stop','target','manual','end_of_day','invalidated') NULL,
  status ENUM('open','closed') NOT NULL DEFAULT 'open',
  -- Cash-account accounting: how much of the purchase used proceeds that had
  -- not yet settled (a sale before they settle is a good-faith violation).
  unsettled_funds_used DECIMAL(14,4) NOT NULL DEFAULT 0,
  funds_settle_on DATE NULL,
  conditions_at_entry_json JSON NULL,
  regime_at_entry VARCHAR(20) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_position_uuid (uuid),
  KEY idx_position_profile (profile_id, mode, status, entry_at),
  CONSTRAINT fk_position_account FOREIGN KEY (account_id) REFERENCES trading_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The review of a closed position. Figures are computed from the position;
-- notes and plan-compliance are the person's.
CREATE TABLE IF NOT EXISTS trading_journal (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  position_id BIGINT UNSIGNED NOT NULL,
  profile_id BIGINT NOT NULL,
  realized_pl DECIMAL(14,4) NOT NULL,
  fees DECIMAL(10,4) NOT NULL,
  planned_risk DECIMAL(14,4) NOT NULL,
  realized_risk DECIMAL(14,4) NULL,
  r_multiple DECIMAL(8,3) NULL,
  entry_slippage DECIMAL(14,4) NULL,
  followed_plan TINYINT(1) NULL,
  notes TEXT NULL,
  chart_snapshot_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_journal_position (position_id),
  KEY idx_journal_profile (profile_id, created_at),
  CONSTRAINT fk_journal_position FOREIGN KEY (position_id) REFERENCES trading_positions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historical simulations, never mixed with paper or real results.
CREATE TABLE IF NOT EXISTS trading_backtest_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  strategy_version_id BIGINT UNSIGNED NOT NULL,
  split ENUM('development','validation','out_of_sample') NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  symbols_json JSON NOT NULL,
  data_source VARCHAR(40) NOT NULL,
  feed VARCHAR(12) NOT NULL,
  cost_model_json JSON NOT NULL,
  metrics_json JSON NULL,
  trades_json JSON NULL,
  status ENUM('running','finished','failed') NOT NULL DEFAULT 'running',
  error VARCHAR(300) NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_backtest_uuid (uuid),
  KEY idx_backtest_strategy (strategy_version_id, split)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per occurrence; dedupe_key makes a repeat of the same occurrence a
-- no-op rather than a second alert.
CREATE TABLE IF NOT EXISTS trading_alerts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id BIGINT NOT NULL,
  kind ENUM('approaching','entry_confirmed','invalidated','position_stop','position_target','daily_risk','event_soon') NOT NULL,
  dedupe_key VARCHAR(160) NOT NULL,
  signal_id BIGINT UNSIGNED NULL,
  position_id BIGINT UNSIGNED NULL,
  symbol VARCHAR(12) NULL,
  title VARCHAR(160) NOT NULL,
  body VARCHAR(500) NOT NULL,
  -- An ENTRY CONFIRMED from a strategy version that is not yet validated is
  -- recorded and shown as a paper signal, not as a live alert.
  validated TINYINT(1) NOT NULL DEFAULT 0,
  delivery_state ENUM('pending','shown','dismissed') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  seen_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_alert_dedupe (profile_id, dedupe_key),
  KEY idx_alert_recent (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The day in one row, recomputed from positions and signals (never typed in).
CREATE TABLE IF NOT EXISTS trading_daily_summaries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id BIGINT NOT NULL,
  session_date DATE NOT NULL,
  mode ENUM('live','paper') NOT NULL,
  trades SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  wins SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  losses SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  realized_pl DECIMAL(14,4) NOT NULL DEFAULT 0,
  fees DECIMAL(10,4) NOT NULL DEFAULT 0,
  r_total DECIMAL(8,3) NULL,
  plan_followed SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  plan_broken SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  signals_confirmed SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  signals_invalidated SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  regime VARCHAR(20) NULL,
  assessment VARCHAR(20) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_daily (profile_id, session_date, mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
