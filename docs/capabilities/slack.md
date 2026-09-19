---
id: slack
title: Slack
summary: I can read recent mentions visible to your connected Slack user and show them in Work.
where: Companion → Work → Connected apps → Slack
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [slack, work, inbox, projects]
---

## What I can do

I show up to five search results mentioning your authenticated Slack user from the last seven days. Each result includes a channel and a link. I can also read these mentions when you ask me about Slack or work.

## Where to find it

Open Connected apps from your Companion menu and choose Slack. Complete
the provider's authorization screen yourself. Once linked, the dashboard and
Work page load the summary automatically. The server must have the provider's
OAuth application configured before Connect can work.

## When it doesn't work

If the connection needs authorization, reconnect it in Connected apps. If the
server reports missing configuration, its owner must configure the OAuth app.
An administrator may also need to allow that app. A failed read is shown as
unavailable rather than as an empty inbox.

## Limits

I do not post, edit, delete, join channels, or change permissions. I use a read-only user grant and only see what that user can search. Slack workspace restrictions, app approval, and search availability can limit results. I do not treat this preview as a full inbox.
The implementation is available, but an account is not connected until the
provider authorization has succeeded.

## Under the hood

- Readers: `../../src/services/connectors/work.js`
- OAuth descriptor: `../../src/services/connectors/registry.js`
- OAuth lifecycle: `../../src/services/connectors/oauth.js`
- Dashboard: `../../src/services/dashboard.js`
- Chat context: `../../src/services/connectors/context.js`
- Frontend: `../../../companion/src/components/Dashboard.tsx`
- Tests: `../../src/services/connectors/work.test.js`, `../../src/services/connectors/oauth.work.test.js`
