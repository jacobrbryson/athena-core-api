# Day-trading intelligence

Family → Trading. Athena acts as an intraday analyst for a small cash account
(Webull, $423, $4/trade, $8/day, 2 trades/day, 2:1 minimum). She evaluates; the
person decides and executes. There is no order path anywhere in this module.

## Data provider

| Provider | Real-time U.S. equities | 1-min history | News | Price (individual) | Notes |
|---|---|---|---|---|---|
| **Alpaca** (chosen) | IEX free; full SIP on Algo Trader Plus | SIP on every plan (older than 15 min) | Benzinga, included | Free / $99 mo | WebSocket (30 symbols free, unlimited paid); screener endpoints for most-actives and movers |
| Massive (Polygon) | Advanced tier only | yes | yes | ~$199 mo for real-time | Starter/Developer are 15-min delayed |
| Finnhub | quotes; candles premium | premium | yes | varies | economic calendar premium |
| Twelve Data | paid tiers | yes | limited | ~$79+ mo | no screener |

Alpaca wins on two points. The free plan already gives full-market SIP history for backtests, and real-time IEX for watching. The full-market real-time upgrade is the cheapest found ($99/mo). The plan names and caps come from Alpaca's docs; check the live pricing page before subscribing.

**Why IEX can't confirm.** IEX carries roughly 2–3% of consolidated volume. Its VWAP, relative volume and spread are not the market's. On IEX the engine still watches and forms setups. `event_data` fails with "feed can watch but not confirm", so ENTRY_CONFIRMED is impossible. `confirmFeeds` is a parameter, and changing it makes a new strategy version.

## Flow

```
dashboard poll / chat question
  → engine.evaluate(profile)            throttled 15 s, single-flight
      → accountState                    ledger balances ∧ Webull settled cash (if checked today)
      → marketOverview                  snapshots: SPY QQQ VIXY + 11 sector ETFs; SPY/QQQ VWAP from candles
      → refreshWatchlist                scanner, 07:00–10:30 ET, every 15 min; frozen after 9:45
      → marketData.todayBars/prior/quotes  REST candles (incremental) + stream quotes, REST fallback
      → strategy.evaluate(symbol)       pure
      → persist                         on status change: snapshot, append event, alerts, paper position
```

Nothing runs on a timer: no every-minute schedulers (cost; Cloud Run spins down). Evaluation happens while someone is looking. The stream stops after ten idle minutes.

## Rules (strategy `orb_vwap`)

All thresholds are in `strategy.js` `DEFAULT_PARAMS`. Every evaluation uses closed candles only: a candle counts once `t + 1 min ≤ asOf`, and swing pivots need `pivotStrength` closed candles after them.

| # | Condition | Definition |
|---|---|---|
| 1 | Above VWAP | last closed 1-min close > session VWAP (Σ vw·v / Σ v from 9:30) |
| 2 | VWAP flat/rising | (VWAP now − VWAP 10 bars ago) / VWAP ≥ −0.03% |
| 3 | Higher lows | last two confirmed 1-min swing lows ascending, price not below the latest |
| 4 | Breakout | a closed candle after 9:45 closes > ORH × 1.0005; fails if a later close < ORH × 0.998 |
| 5 | Retest holds | a later candle's low ≤ ORH × 1.0015 with close ≥ ORH × 0.999, then a later close above that candle's high |
| 6 | Volume | RVOL (cumulative to this minute vs the same minute, 10 prior sessions, same feed) ≥ 1.5 and breakout candle ≥ 1.2× the session's average candle |
| 7 | Spread | (ask − bid)/mid ≤ 0.2% and ≤ 25% of the stop distance |
| 8 | Risk budget | stop = retest low (else last higher low) × 0.9995; stop distance ≥ 0.5 × 1-min ATR(14); sizing yields ≥ 1 share within budget including costs |
| 9 | Reward/risk | nearest resistance above entry (premarket high, prior-day high, session high, swing highs) ≥ 2R away, or none |
| 10 | Event/data | not within 30 min before / 15 min after a scheduled event; candle ≤ 120 s old; quote ≤ 30 s old; feed in `confirmFeeds` |

Gates outside the ten: market (SPY and QQQ both below VWAP → WAIT), extension (more than 4 ATR above VWAP → WAIT), tradeable (price < $5, under $20M/day, 1-min ATR > 1.5% of price, or spread > 0.6% → AVOID), daily limits (→ AVOID), no new entries after 15:00 ET.

Lifecycle: once confirmed, a setup stays ENTRY_CONFIRMED until one of these ends it: stop touched (EXIT_INVALIDATED), target touched (EXIT_INVALIDATED), close below VWAP or the breakout failing (EXIT_INVALIDATED), or price running past entry + 0.5R (WAIT, "don't chase"). Each symbol gets one setup per day.

## Sizing

`risk.js`: shares = floor(min(settled cash / entry, budget / (entry − stop))), then cut until the cost-inclusive loss fits. Costs are slippage on both fills, half the spread each side, commission, SEC fee and TAF. The budget is min(per-trade cap, daily cap − realized loss − open planned risk). The stop is never moved to fit the budget.

## Cash account

`trading_cash_ledger` keeps a signed amount and a `settles_on` date for every movement. Debits count at once; credits count once settled (T+1 for sales, by NYSE calendar). A buy funded partly by unsettled proceeds records `unsettled_funds_used` and `funds_settle_on`. Selling before that date is flagged as a good-faith violation. Sizing uses the lower of the ledger's settled cash and Webull's `settled_cash` when Webull was checked today. **Match ledger to Webull** adds an explicit `adjustment` row; nothing is silently overwritten.

## Persistence and reproducibility

- `trading_signals`: one row per (person, day, symbol, strategy version), rejected setups included. `initial_*` is written once and `status` points at the latest event. `outcome_*` is measured afterwards by `outcomes.js`, never by editing events.
- `trading_signal_events`: append-only (`uq_signal_seq`). Each row holds conditions, indicators, data freshness, levels, sizing and a snapshot id.
- `trading_strategy_versions`: params hashed canonically (sha256). New params mean a new version.
- `trading_candles`: closed candles of watched symbols, kept 400 days. Replay rebuilds what was known at each event from these, filtered to candles closed by then.
- Backtests (`trading_backtest_runs`), paper positions (`mode='paper'`) and real positions (`mode='live'`) never mix in analytics.

## Notifications (2026-10-25)

The owner asked for push notifications for actionable setups. They are an outbox derived from the stored event log, not an initiative trigger, and they do not touch `services/initiative/` beyond reading quiet hours and mutes.

```
monitor tick (Cloud Tasks, ~60 s, open−15 min … close+10 min, only if someone opted in)
  → engine.evaluate(profile)              persists transitions (append-only events)
  → store.expireDue                        EXPIRED event when expires_at passes
  → notifications.sync                     events → outbox rows (INSERT IGNORE on dedupe key)
  → notifications.deliver                  claim → gates → lifecycle.revalidate → push → deliveries
```

**Lifecycle.** WATCH → SETUP_FORMING → ENTRY_CONFIRMED → EXIT_INVALIDATED | EXPIRED. Every signal row now carries `state_key`, `last_evaluated_at`, `expires_at` and `expiry_policy`. A confirmed entry is actionable for 10 minutes (`lifecycle.ENTRY_WINDOW_MIN`), never past the 15:00 ET cutoff or the close; other setups expire at the cutoff. EXPIRED is terminal (strategy.evaluate returns it whatever the candles say). Paper positions now close on stop/target from candles (`engine.managePaper`), because a confirmed signal can expire while its paper position is open.

**Paper setups on IEX.** The IEX feed can never produce ENTRY_CONFIRMED. A WAIT where every condition passed except the feed, on fresh data outside a blackout, is its own state (`WAIT_PAPER_SETUP`) so it gets its own event; it notifies as a PAPER / EXPERIMENTAL confirmation.

**Live vs paper.** Live needs all three: the SIP feed, a `validated` strategy version, and the person switching on live alerts for that strategy (refused for an unvalidated version). Everything else is labelled PAPER / EXPERIMENTAL in the title.

**Dedupe.** One row per (person, `confirm:<signal>` / `forming:<signal>` / `invalid:<signal>` / `expired:<signal>` / `risk:<date>:full|trades`). Forming and confirmed rows come only from a signal's latest event, so switching on mid-day doesn't replay the morning. One signal per symbol per day per strategy version means a new alert needs a genuinely new setup (another symbol, day or version). Invalidation and expiry only retract something that reached a device; otherwise they are recorded as skipped.

**Send-time gates, in order:** opt-in and per-event switches; a `trading` mute; the row's own expiry; setups only while the market is open; quiet hours (hold 15 min and re-check, never drop); re-validation (`lifecycle.revalidate`: market open, entry window, evaluation ≤ 90 s old with fresh quote and closed candle, strategy still confirmed, price above stop and within entry + 0.5R, valid levels and whole shares, R ≥ max(2, account minimum), settled cash ≥ position cost, planned risk with costs ≤ the day's budget, trades left, no event blackout); the person's cooldown (low priority only: forming and paper confirmations; held to its end and re-checked). A failing check ends the row as `lapsed` with the reasons. Live confirmations, invalidations, expiries and risk limits are never held by the cooldown.

**Delivery.** `push.sendToProfile` (existing paired_device rows: FCM, Web Push/VAPID, SMS), collapse key `trading-<uuid>` (per notification, never shared), TTL = seconds left in the entry window so a push service never delivers a stale plan. Soft failures retry at 30 s and 60 s (never past expiry) then `failed`; dead registrations are dropped by push. Every device answer is a `trading_notification_deliveries` row. A row stuck in `sending` for 3 minutes (a crashed worker) returns to `pending`; the per-notification collapse key makes the rare resend replace rather than stack.

**Tap.** The payload carries `/family/trading?setup=<signal>&n=<notification>`; the service worker opens or navigates to it, the page calls `GET /api/v1/trading/setups/:uuid` which forces a fresh evaluation, acknowledges the notification and re-runs `revalidate`. The notified figures are shown as history; only the verdict says whether it still stands. The Android app currently opens its launch screen (deep link needs an APK change).

**Monitoring cost.** About 390 short requests per trading day, only while someone is opted in, and nothing outside the window, so the service still scales to zero overnight and at weekends. `TRADING_MONITOR_INTERVAL_S` (default 60, min 30). The incidents job (every 5 min) restarts a broken chain; the service ignores it while the chain ticked recently.

## Validation status

Not validated. `status` stays `paper` until an owner decides otherwise, on out-of-sample backtest evidence (`scripts/tradingBacktest.js`) plus a paper forward test. Until then, ENTRY_CONFIRMED alerts are labelled paper. Known modelling limits: backtests have no historical quotes, so spread is modelled at 0.05%. A candle touching both stop and target counts as the stop. Symbol choice is the caller's, and survivorship bias is theirs to avoid (the run records the list).

## Not built (later phases)

Regime-adaptive parameters. Multi-strategy comparison. Ranking by validated results. Sector mapping for single-stock relative strength. An earnings calendar.
