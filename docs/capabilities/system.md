---
id: system
title: Athena System
summary: I show whether I'm healthy, what I've cost in total, and this month's model and hosting costs, with OpenAI, Google Cloud and Twilio detail — read-only.
where: Companion → System in the left navigation
status: live
surfaces: [companion]
audiences: [adult]
triggers: [system, health, status, are you ok, Twilio, OpenAI, ChatGPT, Gemini, Google Cloud, GCP, hosting, billing, usage, balance, spend, total spend, lifetime, LLM cost, cost, costing, Athena System]
---

## What I can do

Four figures lead the System page:

- **Athena's health** — Good, Degraded or Down, from a live check of my
  database, whether a model is answering chat (and not failing), and whether
  my nightly review has run in the last two days. When I'm healthy it shows
  when it last checked; otherwise it links to the Health panel, which says
  which check failed and why.
- **Total spend** — everything I've cost so far: Twilio's all-time charges,
  OpenAI since my project was created, and all Google Cloud charges the
  billing export holds. If a provider can't be read it is named as left out,
  never counted as zero.
- **LLM cost** — this month's OpenAI spend plus Gemini API charges billed to
  my Google Cloud project.
- **Hosting cost** — this month's Google Cloud charges, after credits, except
  Gemini.

Below them, each provider has its own panel:

- **OpenAI** — spend this month and today, the last seven days, and a
  breakdown by model and by input or output.
- **Google Cloud** — the Athena project's cost this month after credits, the
  cost before credits and the credits themselves, the last seven days, cost by
  service, hosting vs Gemini, the lifetime total, and the biggest individual
  line items.
- **Twilio** — the account balance, outbound SMS messages sent this month, and
  what those messages cost.

It is a read-only operational view for the person using Companion. It does not
send messages, change billing, top up an account or approve anything.

## Where to find it

After signing in to Companion, choose **System** in the left navigation. Each
provider is read when the page opens, and each panel says on its own when that
provider is unavailable or not set up — one failing does not hide the others.

## When it doesn't work

If Athena's health says Degraded or Down, the Health panel names the check and
the reason — a database that can't be reached, no model answering or one
failing, or a nightly review that has stopped running. If the Google Cloud
panel says the export is still catching up, a newly switched-on export is
backfilling older days first; this month's figures appear once it reaches
them, and nothing is broken. If the OpenAI panel says it is not configured, the system owner needs to add an
OpenAI admin key. If the Google Cloud panel says the billing export is not
switched on yet, the owner turns it on once in the Cloud console (Billing →
Billing export → Standard usage cost), and the first figures arrive a few
hours later. If Twilio says it is not configured, the owner needs to add the
Twilio credentials. If any panel says the provider is unavailable, retry later.
A signed-out or access-locked session must be signed in or unlocked first.

## Limits

- I can't show a prepaid OpenAI credit balance: OpenAI only publishes spend,
  so I show what has been spent, not what is left.
- Google Cloud figures run a few hours behind and cover only the Athena
  project. The export only reaches back to about the month before it was
  switched on; older months count toward the lifetime figure only once the
  owner has loaded them from a Cloud Billing report, and until then Total
  spend misses them.
- My database isn't hosted on Google Cloud, so Hosting cost doesn't include
  it.
- OpenAI's lifetime figure counts the whole OpenAI organization from the day
  my project was created (2025-10-27); if that organization also runs other
  things, they are included.
- Health checks what the API process can see from where it runs; it doesn't
  test every connector, the phone app, or the Guardians site.
- OpenAI's "today" is the UTC day; Google Cloud's month follows its Pacific-time
  invoice month.
- I don't predict future charges, compare against a budget, or change any
  account. Each provider's own billing console is authoritative.

## Under the hood

- Backend readers: `../../src/services/twilioBilling.js`, `../../src/services/openaiBilling.js` (Costs API, `OPENAI_API_ADMIN_KEY`), `../../src/services/gcpBilling.js` (BigQuery `billing_export` dataset, table auto-discovered by the `gcp_billing_export_v1_` prefix; override with `GCP_BILLING_EXPORT_PROJECT` / `GCP_BILLING_EXPORT_DATASET`)
- Health: `../../src/services/systemHealth.js` (database `SELECT 1`, `llm.status()` serving chat + error rate, latest `self_review_report.report_date`)
- GCP history before the export: `billing_export.billing_history` (invoice_month, project_id, service, cost net of credits), loaded from a console Reports/Cost-table CSV with `npm run billing:history -- report.csv [--month YYYYMM] [--dry-run]` (`../../db/load-gcp-billing-history.js`, owner's own ADC). Any month it holds replaces the export for that month in the lifetime sum.
- Lifetime reads: Twilio `Usage/Records/AllTime.json?Category=totalprice`; OpenAI Costs API from `ATHENA_BILLING_SINCE` (default 2025-10-27, cached 1h); GCP export sum for the project. Gemini is split out by service name (`Gemini API` / Generative Language / Vertex AI).
- Route/controller: `../../src/routes/companion.js` (`/system/health`, `/system/twilio-billing`, `/system/openai-billing`, `/system/gcp-billing`), `../../src/controllers/system.js`
- Frontend API and page: `../../../companion/src/api/dashboard.ts`, `../../../companion/src/components/Dashboard.tsx`; mock data in `../../../companion/mock/client.ts` (`?gcp=none` not yet exported, `?gcp=behind` backfilling, `?health=degraded` / `?health=down`)
- Tests: `../../src/services/systemHealth.test.js`, `../../src/services/twilioBilling.test.js`, `../../src/services/openaiBilling.test.js`, `../../src/services/gcpBilling.test.js`
- Prod: `OPENAI_API_ADMIN_KEY` is in Secret Manager with accessor granted to the Cloud Run runtime SA; the runtime SA's project Editor role covers the BigQuery read. The admin key is read-only (rotated to one 2026-09-27) and is an upstream provider credential and rotates manually in the OpenAI console.
