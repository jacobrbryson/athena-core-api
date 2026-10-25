---
id: trading
title: Day-trading desk
summary: I watch the market, rank a few stocks and check them against your day-trading rules and risk limits — analysis only, no orders.
where: Companion → Family → the Trading tab
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [day trade, day trading, trading, watchlist, what are we watching, setup, entry, good entry, vwap, breakout, opening range, stop loss, how many shares, afford, downside, skip trading, strategy, paper trading, backtest, signal, scanner, premarket, rvol, relative volume, reward/risk, trade journal, good-faith violation, settled cash, trading notifications, trading alerts, push alert, setup alert, notify me, paper alert, setup expired, test notification]
---

## What I can do

During market hours I read real market data. That means prices, one- and five-minute candles, quotes, volume and headlines, each with the time it was observed. I tell you whether the market is open and whether the data is real-time, delayed or stale.

From the morning's most active stocks and top gainers, I keep a short watchlist of three to five liquid names you can afford. I filter out penny stocks, wide spreads, ETFs, leveraged and inverse funds, warrants and rights. For each one I say why it's on the list.

After 9:45 AM I check each stock against your strategy. That's an opening-range breakout with a VWAP trend. The rules: price above a flat or rising VWAP, higher lows, a closed candle above the 9:30–9:45 high, a pullback that holds that level, volume, an acceptable spread, a stop from the chart structure that fits your risk budget, at least 2:1 reward to risk before the next resistance, and no scheduled event or data problem.

Each stock gets one status: Watch, Setup forming, Entry confirmed, Wait, Avoid, or Exit / invalidated. You also see every condition as pass, fail or pending, and what would have to happen next.

When a plan exists, I show the entry, stop and target. I show the whole-share quantity your settled cash and your $4 risk allow, the capital needed, and the planned loss and gain with and without costs. I put those levels on the chart. I only use settled cash: sale proceeds don't count until they settle the next trading day, and unrealized gains never count.

You record your own trades. I track them in a journal: planned against actual, fees, slippage, P/L, R-multiple and whether you followed the plan. I warn you if a sale would be a good-faith violation. I also run a paper forward test of every confirmed signal, kept apart from your real trades and from backtests. Results show by day, week and month, with an equity curve, a calendar, and breakdowns by setup and market regime. You can replay any past signal exactly as it looked at the time.

When you switch on trading notifications, I watch your watchlist during market hours even with Athena closed, and push to your phone and subscribed browsers when a setup is forming, when an entry is confirmed, when a setup I told you about stops being valid or expires, and when you hit a daily risk limit. A confirmed alert carries the ticker, setup, entry, stop, target, shares, capital, planned dollar risk, reward/risk and when its entry window ends — all copied from the stored signal, never estimated. Right before sending, and again when you tap it, I re-check it against the market now: if the price ran, the data went stale, the cash or risk budget is gone, or the window closed, I don't send it, and tapping shows why it's no longer actionable. Unless the strategy is validated, you switched on live alerts for it, and the data is full-market, every alert says PAPER / EXPERIMENTAL. One alert per setup; a confirmed entry is good for ten minutes.

In chat I can answer "what are we watching?", "is this a good entry?", "how many shares can we afford?", "what's our downside?", "should we skip today?" and "how did we do this week?" from those same figures. Often the honest answer is that there isn't a trade worth taking.

## Where to find it

Companion → **Family** → the **Trading** tab. It has four views:

- **Desk**: market, watchlist, chart, checklist and plan.
- **Journal**: record a buy or a sale.
- **History**: results and signal replay.
- **Settings**: risk rules, **Notifications** (on/off, which alerts, paper alerts, live alerts once validated, sound, cooldown, test, devices), cash, deposits, and **Check Webull** / **Match ledger to Webull**.

**History** also lists every trading notification — sent, held, lapsed or skipped, with the reason and each device's answer. Tapping a notification opens the Desk with that setup re-checked now.

It needs a market-data connection that the owner sets up once. There's no Connect button.

## When it doesn't work

- **"Market data not connected"**: no market-data key is set up yet. The journal and settings still work.
- **"Real-time · IEX only · can't confirm"**: the free data feed only sees one exchange, a few percent of all trading. I can watch with it, but I won't confirm an entry on it. That needs full-market real-time data.
- **A stock shows "stale"**: its latest candle or quote is too old. I won't judge a setup on old data, so it waits until fresh data arrives.
- **An empty watchlist**: nothing passed the filters. That's a valid answer; there may be no trade today.
- **No trading notification arrived**: check Trading → History → Notification history. "Lapsed" means I re-checked and it no longer held; "Held" means quiet hours or your cooldown; "Not delivered" names the device problem. **Send a test notification** in Settings proves the path. Push also needs "Allow push notifications" on and a subscribed phone or browser; a browser where notifications are blocked has to be allowed in its site settings.
- **Tapping on Android opens the home screen**: the current Android app opens Athena but not the exact setup yet. Open Family → Trading; the notification history links the setup.
- **"Check Webull" fails**: Webull isn't linked or needs re-linking (see the Webull capability).

## Limits

- I never place, change or cancel an order. Every decision and every execution is yours. A status is an analytical signal, not a prediction or an instruction, and I'm not a licensed advisor.
- Long-only stocks in a cash account: no margin, options, shorting or overnight holds.
- The strategy hasn't been validated yet. Until backtests and paper trading show out-of-sample evidence, an Entry confirmed alert is marked as a paper signal. I don't claim it's profitable.
- Push needs the owner to have set up server-side monitoring; if not, Settings says so and I only evaluate while the page is open.
- Quiet hours hold trading notifications until they end; a setup that expires meanwhile is never sent late. A cooldown holds forming and paper alerts only.
- The event calendar covers Fed rate decisions. CPI, jobs-report and earnings dates aren't included unless the owner adds them.
- My volatility gauge is VIXY, an ETF that tracks VIX futures, not the VIX itself. Breadth is how many of the eleven sector ETFs are above their VWAP.
- Without notifications switched on, I evaluate only while the Trading page or a chat question asks me to. With them on, I check about once a minute from 15 minutes before the open to 10 minutes after the close.
- I can't know whether a stop order filled at its price. Stops can fill worse in a fast move, a gap or a halt.

## Under the hood

**Never sent to a model.**

- Engine (pure, shared by live, replay and backtest): `src/services/trading/strategy.js` (`DEFAULT_PARAMS`, `evaluate`), `src/services/trading/indicators.js`, `src/services/trading/risk.js`, `src/services/trading/cash.js`, `src/services/trading/marketClock.js` (NYSE holidays/early closes through 2027, T+1), `src/services/trading/events.js` (FOMC 2026 + `TRADING_EXTRA_EVENTS` secret JSON), `src/services/trading/analytics.js`, `src/services/trading/backtest.js`, `src/services/trading/scanner.js`.
- Data: `src/services/trading/alpaca.js` — Alpaca Market Data REST + one WebSocket (reconnect with backoff, 30-symbol free cap); `src/services/trading/marketData.js` caches candles per day and stores closed ones. Secrets `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `ALPACA_DATA_FEED` (`iex` default | `sip` | `delayed_sip`). Only `sip` may confirm (`confirmFeeds`). Data-only: no trading endpoint exists in this module.
- Orchestration: `src/services/trading/engine.js` (`evaluate` throttled 15 s per person, `persist` → snapshot + append-only event + alerts + paper position, `recordEntry`/`recordExit`/`recordCash`/`reconcile`, `performance`, `replay`). `src/services/trading/store.js` is all SQL. `src/services/trading/outcomes.js` measures outcomes nightly (`tradingOutcomes` step in `src/jobs/nightly.js`) and prunes (400 days candles/symbol snapshots, 90 days market snapshots).
- Chat: `src/services/trading/context.js` (keyword gate + grounding block), wired in `src/controllers/gemini.js` beside healthPlan.
- Routes: `src/routes/trading.js` at `/api/v1/trading/*`, adult-only, own profile.
- Schema: `db/migrations/0092_trading.up.sql` — 13 tables (the 11 specified plus `trading_cash_ledger` and `trading_candles`). Applied 2026-10-23.
- Backtests: `scripts/tradingBacktest.js` (chronological 60/20/20 split; `--save` writes runs).
- Frontend: `../../../companion/src/components/FamilyTrading.tsx`, `../../../companion/src/components/TradingChart.tsx`, `../../../companion/src/api/trading.ts`, path `/family/trading`; mock data `../../../companion/mock/trading.ts`.
- Design: `docs/architecture/trading.md`. Tests: `src/services/trading/trading.test.js`.
- Not in the action layer and must not be: recording a trade is bookkeeping of what the person did. Any future order placement would be a new action under `services/actions/` (protected; owner authorization, propose → approve → audit, no standing approval by default).
- Push (owner-requested 2026-10-25): `src/services/trading/lifecycle.js` (pure: expiry policy, paper-setup state, candidates from stored events, `revalidate`, `render`), `src/services/trading/notifications.js` (prefs, outbox `trading_notifications` with dedupe key per setup, claim → gates → re-validate → `push.sendToProfile` → `trading_notification_deliveries`), `src/services/trading/monitor.js` (Cloud Tasks chain `trading-tick-<minute>` to `POST /internal/trading/tick`, `src/controllers/tradingMonitor.js`, Guardian dispatch SA; backstop in `src/jobs/incidents.js`). Not an initiative trigger and does not touch `services/initiative/`: it reads `getPref`/`inQuietHours`/`listMutes` only. Opt-in per person (`trading_notification_prefs`, no row = off) plus account push consent (`push_enabled`). Migration `db/migrations/0098_trading_notifications.up.sql` — **must be applied before deploying this code** (recordEvaluation writes `state_key`). Tests: `notifications.test.js`, `monitor.test.js`. Android deep links need an APK change (tap currently opens the launch intent).
