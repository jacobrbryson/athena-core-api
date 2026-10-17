---
id: system
title: Athena System
summary: The System page — an Overview of my health, costs and dreams, with tabs for Calendar, Mail, Projects, News, Dreams and Finance (time saved, what I cost).
where: Companion → System in the left navigation; its tabs are Overview, Calendar, Mail, Projects, News, Dreams and Finance
status: live
surfaces: [companion]
audiences: [adult]
triggers: [system, system page, overview, finance, finance tab, quick actions, service costs, system health, time saved, saved me, worth it, value, minutes saved, hours saved, health, status, are you ok, Twilio, OpenAI, ChatGPT, Gemini, Google Cloud, GCP, hosting, billing, usage, balance, spend, total spend, lifetime, LLM cost, cost, costing, Athena System]
---

## What I can do

The System page has tabs along the top: **Overview**, **Calendar**, **Mail**,
**Projects**, **News**, **Dreams** and **Finance**. Calendar, Mail, Projects,
News and Dreams used to be in the left menu; they are the same pages, now
reached from here.

The **Overview** is everything at a glance:

- A line under the title: how many of your services are connected, how many
  of my health checks pass, and when I last checked.
- A tile for each of Calendar (events in the next seven days, one bar a day),
  Mail (emails waiting for review and how many I'm still sorting, with bars
  for receipts, travel, school and other), Projects (open projects, how many
  are active and blocked, and a bar split by state) and News (headlines I read
  this week, one bar a day). Tapping a tile opens its tab. A source that can't
  be read shows — and says why rather than a made-up number.
- **Dreams** — nights I dreamed in the last thirty days, statements I ran in
  my own database, the questions I'm holding for you, and a bar for each of
  the last thirty nights; beside it, my most recent dream with its painting,
  the start of the story and what actually happened.
- **System Health** — All systems operational, Some things need attention, or
  Something is down, from a live check of my database, whether a model is
  answering chat (and not failing), and whether my nightly review has run in
  the last two days, plus an Integrations entry that says how many of your
  connected services can't be read right now. View details lists every check
  and why.
- **Service Costs** — this month so far: the total, OpenAI and Google Cloud
  (each with its last seven days) and Twilio's texts. View details opens
  Finance.
- **Quick Actions** — Ask a question, Add a calendar event and Report an issue
  start a message to me; Create a task opens a new project; Explore memories
  opens your memories.

The **Finance** tab is what this page used to be. Four figures lead it:

- **Time saved** — the minutes my approved actions saved you this month. Only
  things I actually did after you (or a standing approval) said yes count:
  adding a calendar event is 2 minutes, filing a travel or school email with
  its event 2.5, filing a receipt 0.5, trashing an email 0.25, archiving an
  email 0.1, adding an event from an email 2.5, unsubscribing from a sender 1,
  saving a reply draft 2, saving a memory 0.5. A bundle counts every email it covered, so
  archiving 30 promos in one approval is 3 minutes. Dismissing a row from my own mail list and looking through the camera
  count as zero for now. The numbers are deliberately low; proposals you
  declined, answers I gave and summaries you read count for nothing yet.
- **Total spend** — everything I've cost so far: Twilio's all-time charges,
  OpenAI since my project was created, and all Google Cloud charges the
  billing export holds. If a provider can't be read it is named as left out,
  never counted as zero.
- **LLM cost** — this month's OpenAI spend plus Gemini API charges billed to
  my Google Cloud project.
- **Hosting cost** — this month's Google Cloud charges, after credits, except
  Gemini.

Below them, the **Time saved** panel shows this month, last month and the
lifetime total, the last seven days, and this month broken down by action —
each line shows the count and the minutes credited for one, so every figure
can be checked by hand. I record minutes, not money.

Each provider also has its own panel:

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

After signing in to Companion, choose **System** in the left navigation (on a
phone: Dashboards → System), then pick a tab. Calendar, Mail, Projects, News
and Dreams are no longer in the left menu — they are tabs here, and the cards
on Dashboard still open them directly. Each provider is read when the page opens, and each panel says on its own when that
provider is unavailable or not set up — one failing does not hide the others.

## When it doesn't work

If System Health says something needs attention or is down, View details
names the check and the reason — a database that can't be reached, no model answering or one
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
- Time saved uses UTC months and counts only approved, completed actions, at
  fixed per-action minutes. It isn't a measurement of your day, and it will
  undercount.
- I don't predict future charges, compare against a budget, or change any
  account. Each provider's own billing console is authoritative.

## Under the hood

- Backend readers: `../../src/services/twilioBilling.js`, `../../src/services/openaiBilling.js` (Costs API, `OPENAI_API_ADMIN_KEY`), `../../src/services/gcpBilling.js` (BigQuery `billing_export` dataset, table auto-discovered by the `gcp_billing_export_v1_` prefix; override with `GCP_BILLING_EXPORT_PROJECT` / `GCP_BILLING_EXPORT_DATASET`)
- Time saved: `../../src/services/timeSaved.js` (`MINUTES` per registry action id; reads `athena_action` rows with `status = 'done'` for the caller's own profile, except `fix_code`, which counts only when `codeAgents.fixStatus` reports the pull request merged; a new action with no entry counts 0 and a test fails until it gets a deliberate value)
- Health: `../../src/services/systemHealth.js` (database `SELECT 1`, `llm.status()` serving chat + error rate, latest `self_review_report.report_date`)
- GCP history before the export: `billing_export.billing_history` (invoice_month, project_id, service, cost net of credits), loaded from a console Reports/Cost-table CSV with `npm run billing:history -- report.csv [--month YYYYMM] [--dry-run]` (`../../db/load-gcp-billing-history.js`, owner's own ADC). Any month it holds replaces the export for that month in the lifetime sum.
- Lifetime reads: Twilio `Usage/Records/AllTime.json?Category=totalprice`; OpenAI Costs API from `ATHENA_BILLING_SINCE` (default 2025-10-27, cached 1h); GCP export sum for the project. Gemini is split out by service name (`Gemini API` / Generative Language / Vertex AI).
- Route/controller: `../../src/routes/companion.js` (`/system/health`, `/system/time-saved`, `/system/twilio-billing`, `/system/openai-billing`, `/system/gcp-billing`), `../../src/controllers/system.js`
- Frontend API and pages: `../../../companion/src/api/dashboard.ts`; the Overview and tab strip are `../../../companion/src/components/SystemPage.tsx` + `system.css` (tiles reuse Health's `hp-tile`, tabs reuse Property's `SectionTabs`); the Finance tab (`FinancePage`) and the tab pages are in `../../../companion/src/components/Dashboard.tsx`, which passes the tiles their data from the same reads the tabs use; mock data in `../../../companion/mock/client.ts` (`?gcp=none` not yet exported, `?gcp=behind` backfilling, `?health=degraded` / `?health=down`, `?saved=none`)
- Tests: `../../src/services/timeSaved.test.js`, `../../src/services/systemHealth.test.js`, `../../src/services/twilioBilling.test.js`, `../../src/services/openaiBilling.test.js`, `../../src/services/gcpBilling.test.js`
- Prod: `OPENAI_API_ADMIN_KEY` is in Secret Manager with accessor granted to the Cloud Run runtime SA; the runtime SA's project Editor role covers the BigQuery read. The admin key is read-only (rotated to one 2026-09-27) and is an upstream provider credential and rotates manually in the OpenAI console.
