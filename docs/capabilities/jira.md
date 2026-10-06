---
id: jira
title: Jira Cloud
summary: I can read your assigned open Jira Cloud issues and group them by project on the dashboard.
where: Companion → Work → Connected apps → Jira Cloud
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [jira, work, inbox, projects]
---

## What I can do

I read assigned issues whose status category is not Done from authorized Jira Cloud sites. Work shows a preview and Projects groups the returned issues. I can also read this summary when you ask about Jira or projects. For each issue I also know whether it's in progress (Jira's own status grouping, so "Code Review" counts) and, for the whole read, whether Jira had more than I returned. The dashboard's Working banner uses that to show the ticket you're in the middle of.

## Work site by API token

An account can also have Jira added by the owner with a personal API token for
its work site instead of the authorization screen. Such an account is already
connected, needs no steps, and reads that one site directly.

## Where to find it

Open Connected apps from your Companion menu and choose Jira Cloud. Complete
the provider's authorization screen yourself. Once linked, the dashboard and
Work page load the summary automatically. The server must have the provider's
OAuth application configured before Connect can work.

## When it doesn't work

If the connection needs authorization, reconnect it in Connected apps. If the
server reports missing configuration, its owner must configure the OAuth app.
An administrator may also need to allow that app. A failed read is shown as
unavailable rather than as an empty inbox.

## Limits

I do not change issues or projects. I read up to ten issues from each of up to five sites, with at most twenty-five in the summary. Counts describe this bounded snapshot, not all work in your organization. Jira Server and Data Center are not supported. A failed site is marked as a partial result.
The implementation is available, but an account is not connected until the
provider authorization has succeeded.

## Under the hood

- Readers: `../../src/services/connectors/work.js`
- API-token path (an `api_key` credential row; added with `../../scripts/addJiraApiToken.js`): `../../src/services/connectors/jiraApiToken.js`
- OAuth descriptor: `../../src/services/connectors/registry.js`
- OAuth lifecycle: `../../src/services/connectors/oauth.js`
- Dashboard: `../../src/services/dashboard.js`
- Chat context: `../../src/services/connectors/context.js`
- Frontend: `../../../companion/src/components/Dashboard.tsx`
- Tests: `../../src/services/connectors/jiraApiToken.test.js`, `../../src/services/connectors/work.test.js`, `../../src/services/connectors/oauth.work.test.js`
