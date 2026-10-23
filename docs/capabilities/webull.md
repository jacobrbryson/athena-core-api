---
id: webull
title: Webull brokerage
summary: With your Webull account linked, I can see your portfolio value on the Family dashboard and your balances, positions and orders on Family → Finance — read-only.
where: Companion dashboard → Family dashboard metric or Family → Finance tab
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [webull, brokerage, portfolio, stocks, stock, shares, positions, holdings, buying power, invested, investments, net worth, unrealized, p&l, profit and loss, open orders, trades, day trades, finance tab]
---

## What I can do

With your Webull brokerage account linked, I can read every account Webull
lists for you: net account value, cash, buying power, today's gain or loss,
open profit and loss, and how many day trades you have left. For each
position I see the symbol, quantity, last price, your cost and the unrealized
gain. I also see your open orders and your orders from the last 30 days.

The main Family dashboard shows your Webull net account value as a compact,
read-only metric. The **Finance** tab shows all of your balances, positions
and orders. If the accounts use different currencies, I leave the combined
value blank instead of converting them. In chat I can answer "how's my
portfolio doing?", "what do I own?" or "how much buying power do I have?"
from Webull's own figures. Numbers refresh every five minutes, or when you
press Refresh.

This is read-only. I can't buy, sell, change or cancel anything.

## Where to find it

Companion dashboard → **Family** for the portfolio value, or **Family** → the
**Finance** tab for account details.

There is no Connect button. Webull doesn't offer a sign-in link for personal
accounts, so the owner links it once: apply for API access on Webull's
developer site, generate an App Key and Secret, then run the link script. If
your Webull account has two-factor sign-in on, Webull sends a text code to
approve in the Webull app during that step.

That approval lasts about 15 days. I renew it on my own each night once it's
within three days of running out, so nobody has to re-run the link script.

## When it doesn't work

- **"Needs re-linking"** — Webull refused the saved key, or the approval
  token ran out and Webull wanted a new text-message approval before it would
  renew it. I can't approve that myself, so I keep using the old approval
  until its last night and only then show this. The owner running the link
  script again fixes it. If you ask about your portfolio in the last two days
  before it runs out, I'll mention it.
- **"Webull is unavailable"** — Webull didn't answer or asked us to slow down.
  Wait a minute and press Refresh.
- **A number looks blank** — Webull didn't send that figure for that account
  type. Event-contract accounts have no cash balance, for example.

## Limits

- I can't place, change or cancel orders, and I don't move money.
- I'm not a licensed financial advisor. I can tell you what's in your account
  and what changed, but not what you personally should buy or sell.
- Only one Webull login per person, and only the person who linked it sees it
  — not the rest of the family.
- Prices are Webull's last price, not a live streaming quote.
- Orders go back 30 days here, even though Webull keeps more.

## Under the hood

**Never sent to a model.**

- Connector: `src/services/connectors/webull.js` — HMAC request signing (SHA-256 by default as the official SDK does; `WEBULL_SIGNATURE_ALGORITHM=HMAC-SHA1` matches the docs' example), keyword gate, `get_brokerage_portfolio` tool, 5-minute snapshot cache, 1.1 s spacing for the 2-per-2s production limit.
- Link: `scripts/addWebullLogin.js` (`WEBULL_APP_KEY`, `WEBULL_APP_SECRET`, optional `WEBULL_ENV=sandbox`, `--no-2fa`, `--dry-run`). Credential columns: `external_account_id` = App Key, `access_token_enc` = App Secret, `refresh_token_enc` = 2FA token, `expires_at` = the token's expiry from Webull's `expires`/`expires_at` (ms), `token_type` = environment.
- Token renewal: the `webullToken` step of nightly maintenance (`src/jobs/nightly.js`) calls `renewEveryone()` → `renew()` for every active `webull` link. No new scheduler. A link without `expires_at` has it filled in from `/auth/tokens/check` first. Once the token is within 3 days of expiring, `refreshToken()` POSTs `{token}` to `/openapi/auth/token/refresh` (v3, as the official Python SDK's `RefreshTokenRequest` does). A reply that isn't `NORMAL` is re-checked with `/auth/tokens/check`. Only a `NORMAL` token is stored, via `credentials.updateTokens` (actor `webull-renew`), with its new expiry. The App Secret is rewritten unchanged.
- Whether refresh needs a new SMS approval isn't documented. Webull's docs only say tokens "need to be refreshed before expiration", the SDK never calls refresh itself, and it hasn't been tried against a real account yet. The code handles both answers. If the reply is `PENDING`, any other status, or an error, nothing is stored and the old token is kept, and the next night tries again. On the last night before it lapses (under 30 h left), `markNeedsReauth` records why and points to the link script. It doesn't mark earlier because `markNeedsReauth` clears `access_token_enc`, which here is the App Secret, so reads would stop days early. While it's under 2 days, `buildContext` adds a line saying so, using `token_expires_at` on the snapshot.
- Route: `GET /api/v1/finance/brokerage` (`?fresh=1`, honoured once a minute) in `src/routes/finance.js`; adult-only, own profile only.
- Frontend: shared read hook `../../../companion/src/components/useBrokerage.ts`; dashboard metric in `../../../companion/src/components/FamilyPage.tsx`; full view in `../../../companion/src/components/FamilyFinance.tsx`; paths `/family` and `/family/finance`.
- Tests: `src/services/connectors/webull.test.js`.
- Safety: `READ_PATHS` in the connector is an allowlist, and order place/replace/cancel paths aren't in it. The token refresh path is the only addition, and it can't move money. Trading would be a new action under `services/actions/`, which is protected and needs the owner's authorization. It must go through propose → approve → audit and must not get a standing approval by default.
- Linked for the owner 2026-10-23: HMAC-SHA256 signing works in production, and the account and balance field names matched. Webull doesn't send `day_trades_left` on a cash account. The token Webull issued had a fixed expiry about 15 days out (2026-11-07), so it lapses even with daily use. The nightly renewal above was added for that on 2026-10-23. Its first real refresh is due the night of 2026-11-04. Positions and orders parsing hasn't been seen on real data yet because the account holds no positions, so status stays `partial`.
