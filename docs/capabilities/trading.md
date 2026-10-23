---
id: trading
title: Day-trading desk
summary: I watch the market, rank a few stocks and check them against your day-trading rules and risk limits — analysis only, no orders.
where: Companion → Family → the Trading tab
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [day trade, day trading, trading, watchlist, what are we watching, setup, entry, good entry, vwap, breakout, opening range, stop loss, how many shares, afford, downside, skip trading, strategy, paper trading, backtest, signal, scanner, premarket, rvol, relative volume, reward/risk, trade journal, good-faith violation, settled cash]
---

## What I can do

During market hours I read real market data. That means prices, one- and five-minute candles, quotes, volume and headlines, each with the time it was observed. I tell you whether the market is open and whether the data is real-time, delayed or stale.

From the morning's most active stocks and top gainers, I keep a short watchlist of three to five liquid names you can afford. I filter out penny stocks and wide spreads. For each one I say why it's on the list.

After 9:45 AM I check each stock against your strategy. That's an opening-range breakout with a VWAP trend. The rules: price above a flat or rising VWAP, higher lows, a closed candle above the 9:30–9:45 high, a pullback that holds that level, volume, an acceptable spread, a stop from the chart structure that fits your risk budget, at least 2:1 reward to risk before the next resistance, and no scheduled event or data problem.

Each stock gets one status: Watch, Setup forming, Entry confirmed, Wait, Avoid, or Exit / invalidated. You also see every condition as pass, fail or pending, and what would have to happen next.

When a plan exists, I show the entry, stop and target. I show the whole-share quantity your settled cash and your $4 risk allow, the capital needed, and the planned loss and gain with and without costs. I put those levels on the chart. I only use settled cash: sale proceeds don't count until they settle the next trading day, and unrealized gains never count.

You record your own trades. I track them in a journal: planned against actual, fees, slippage, P/L, R-multiple and whether you followed the plan. I warn you if a sale would be a good-faith violation. I also run a paper forward test of every confirmed signal, kept apart from your real trades and from backtests. Results show by day, week and month, with an equity curve, a calendar, and breakdowns by setup and market regime. You can replay any past signal exactly as it looked at the time.

In chat I can answer "what are we watching?", "is this a good entry?", "how many shares can we afford?", "what's our downside?", "should we skip today?" and "how did we do this week?" from those same figures. Often the honest answer is that there isn't a trade worth taking.

## Where to find it

Companion → **Family** → the **Trading** tab. It has four views:

- **Desk**: market, watchlist, chart, checklist and plan.
- **Journal**: record a buy or a sale.
- **History**: results and signal replay.
- **Settings**: risk rules, cash, deposits, and **Check Webull** / **Match ledger to Webull**.

It needs a market-data connection that the owner sets up once. There's no Connect button.

## When it doesn't work

- **"Market data not connected"**: no market-data key is set up yet. The journal and settings still work.
- **"Real-time · IEX only · can't confirm"**: the free data feed only sees one exchange, a few percent of all trading. I can watch with it, but I won't confirm an entry on it. That needs full-market real-time data.
- **A stock shows "stale"**: its latest candle or quote is too old. I won't judge a setup on old data, so it waits until fresh data arrives.
- **An empty watchlist**: nothing passed the filters. That's a valid answer; there may be no trade today.
- **"Check Webull" fails**: Webull isn't linked or needs re-linking (see the Webull capability).

## Limits

- I never place, change or cancel an order. Every decision and every execution is yours. A status is an analytical signal, not a prediction or an instruction, and I'm not a licensed advisor.
- Long-only stocks in a cash account: no margin, options, shorting or overnight holds.
- The strategy hasn't been validated yet. Until backtests and paper trading show out-of-sample evidence, an Entry confirmed alert is marked as a paper signal. I don't claim it's profitable.
- Alerts show on the Trading page. I don't send them to your phone yet.
- The event calendar covers Fed rate decisions. CPI, jobs-report and earnings dates aren't included unless the owner adds them.
- My volatility gauge is VIXY, an ETF that tracks VIX futures, not the VIX itself. Breadth is how many of the eleven sector ETFs are above their VWAP.
- I evaluate while the Trading page or a chat question asks me to, about every 15 seconds. I don't watch the market in the background when nobody's looking.
- I can't know whether a stop order filled at its price. Stops can fill worse in a fast move, a gap or a halt.

## Under the hood

**Never sent to a model.**

- Engine (pure, shared by live, replay and backtest): `src/services/trading/strategy.js` (`DEFAULT_PARAMS`, `evaluate`), `src/services/trading/indicators.js`, `src/services/trading/risk.js`, `src/services/trading/cash.js`, `src/services/trading/marketClock.js` (NYSE holidays/early closes through 2027, T+1), `src/services/trading/events.js` (FOMC 2026 + `TRADING_EXTRA_EVENTS` secret JSON), `src/services/trading/analytics.js`, `src/services/trading/backtest.js`, `src/services/trading/scanner.js`.
- Data: `src/services/trading/alpaca.js` — Alpaca Market Data REST + one WebSocket (reconnect with backoff, 30-symbol free cap); `src/services/trading/marketData.js` caches candles per day and stores closed ones. Secrets `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `ALPACA_DATA_FEED` (`iex` default | `sip` | `delayed_sip`). Only `sip` may confirm (`confirmFeeds`). Data-only: no trading endpoint exists in this module.
- Orchestration: `src/services/trading/engine.js` (`evaluate` throttled 15 s per person, `persist` → snapshot + append-only event + alerts + paper position, `recordEntry`/`recordExit`/`recordCash`/`reconcile`, `performance`, `replay`). `src/services/trading/store.js` is all SQL. `src/services/trading/outcomes.js` measures outcomes nightly (`tradingOutcomes` step in `src/jobs/nightly.js`) and prunes (400 days candles/symbol snapshots, 90 days market snapshots).
- Chat: `src/services/trading/context.js` (keyword gate + grounding block), wired in `src/controllers/gemini.js` beside healthPlan.
- Routes: `src/routes/trading.js` at `/api/v1/trading/*`, adult-only, own profile.
- Schema: `db/migrations/0092_trading.up.sql` — 13 tables (the 11 specified plus `trading_cash_ledger` and `trading_candles`). Not yet applied to production.
- Backtests: `scripts/tradingBacktest.js` (chronological 60/20/20 split; `--save` writes runs).
- Frontend: `../../../companion/src/components/FamilyTrading.tsx`, `../../../companion/src/components/TradingChart.tsx`, `../../../companion/src/api/trading.ts`, path `/family/trading`; mock data `../../../companion/mock/trading.ts`.
- Design: `docs/architecture/trading.md`. Tests: `src/services/trading/trading.test.js`.
- Not in the action layer and must not be: recording a trade is bookkeeping of what the person did. Any future order placement would be a new action under `services/actions/` (protected; owner authorization, propose → approve → audit, no standing approval by default).
- Push alerts would be a new initiative trigger (`services/initiative/` is protected; enabling a trigger is the owner's decision). Until then alerts live in `trading_alerts` and show on the page.
