---
id: system
title: Athena System
summary: I show a live, read-only view of what the services I run on cost — OpenAI spend, Google Cloud cost, and the Twilio balance — when each is configured.
where: Companion → System in the left navigation
status: live
surfaces: [companion]
audiences: [adult]
triggers: [system, Twilio, OpenAI, ChatGPT, Google Cloud, GCP, billing, usage, balance, spend, cost, costing, Athena System]
---

## What I can do

The System page shows what running me costs, month to date:

- **OpenAI** — spend this month and today, the last seven days, and a
  breakdown by model and by input or output.
- **Google Cloud** — the Athena project's cost this month after credits, the
  cost before credits and the credits themselves, the last seven days, cost by
  service, and the biggest individual line items.
- **Twilio** — the account balance, outbound SMS messages sent this month, and
  what those messages cost.

It is a read-only operational view for the person using Companion. It does not
send messages, change billing, top up an account or approve anything.

## Where to find it

After signing in to Companion, choose **System** in the left navigation. Each
provider is read when the page opens, and each panel says on its own when that
provider is unavailable or not set up — one failing does not hide the others.

## When it doesn't work

If the OpenAI panel says it is not configured, the system owner needs to add an
OpenAI admin key. If the Google Cloud panel says the billing export is not
switched on yet, the owner turns it on once in the Cloud console (Billing →
Billing export → Standard usage cost), and the first figures arrive a few
hours later. If Twilio says it is not configured, the owner needs to add the
Twilio credentials. If any panel says the provider is unavailable, retry later.
A signed-out or access-locked session must be signed in or unlocked first.

## Limits

- I can't show a prepaid OpenAI credit balance: OpenAI only publishes spend,
  so I show what has been spent, not what is left.
- Google Cloud figures run a few hours behind, cover only the Athena project,
  and start from the day the billing export was switched on — there is no
  earlier history.
- OpenAI's "today" is the UTC day; Google Cloud's month follows its Pacific-time
  invoice month.
- I don't predict future charges, compare against a budget, or change any
  account. Each provider's own billing console is authoritative.

## Under the hood

- Backend readers: `../../src/services/twilioBilling.js`, `../../src/services/openaiBilling.js` (Costs API, `OPENAI_API_ADMIN_KEY`), `../../src/services/gcpBilling.js` (BigQuery `billing_export` dataset, table auto-discovered by the `gcp_billing_export_v1_` prefix; override with `GCP_BILLING_EXPORT_PROJECT` / `GCP_BILLING_EXPORT_DATASET`)
- Route/controller: `../../src/routes/companion.js` (`/system/twilio-billing`, `/system/openai-billing`, `/system/gcp-billing`), `../../src/controllers/system.js`
- Frontend API and page: `../../../companion/src/api/dashboard.ts`, `../../../companion/src/components/Dashboard.tsx`; mock data in `../../../companion/mock/client.ts` (`?gcp=none` shows the not-yet-exported state)
- Tests: `../../src/services/twilioBilling.test.js`, `../../src/services/openaiBilling.test.js`, `../../src/services/gcpBilling.test.js`
- Prod: `OPENAI_API_ADMIN_KEY` is in Secret Manager with accessor granted to the Cloud Run runtime SA; the runtime SA's project Editor role covers the BigQuery read. The admin key is read-only (rotated to one 2026-09-27) and is an upstream provider credential and rotates manually in the OpenAI console.
