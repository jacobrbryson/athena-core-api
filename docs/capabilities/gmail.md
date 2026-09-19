---
id: gmail
title: Gmail
summary: I can read unread inbox message headers from the Gmail account you connect and show them in Work.
where: Companion → Work → Connected apps → Gmail
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [gmail, work, inbox, projects]
---

## What I can do

I show up to five unread inbox messages, including subject, sender, and date. I identify the connected mailbox on the Work page. I can also read this summary when you ask me about Gmail or work.

## Where to find it

Open Connected apps from your Companion menu and choose Gmail. Complete
the provider's authorization screen yourself. Once linked, the dashboard and
Work page load the summary automatically. The server must have the provider's
OAuth application configured before Connect can work.

## When it doesn't work

If the connection needs authorization, reconnect it in Connected apps. If the
server reports missing configuration, its owner must configure the OAuth app.
An administrator may also need to allow that app. A failed read is shown as
unavailable rather than as an empty inbox.

## Limits

I cannot send, delete, archive, mark as read, download attachments, or read full message bodies through this connector. This is one connected mailbox per active credential selection; choose your work account on Google's consent screen.
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
