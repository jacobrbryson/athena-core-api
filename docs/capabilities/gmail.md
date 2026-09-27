---
id: gmail
title: Gmail
summary: I can read unread inbox message headers from the Gmail account you connect and show them in Work.
where: approve it when you sign in with Google, or ⋯ menu → Connected apps → Google → Gmail → Connect
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [gmail, work, inbox, projects]
---

## What I can do

I show up to five unread inbox messages, including subject, sender, and date. I identify the connected mailbox on the Work page. I can also read this summary when you ask me about Gmail or work.

## Where to find it

Signing in with Google asks for Gmail along with Calendar and Contacts on one
Google screen; leave it ticked and it's linked to the account you signed in
with. If Gmail is already linked to a different account (a work inbox, say),
signing in leaves it on that account.

To connect it separately — or to use a different account — open Connected
apps from your Companion menu, find the Google card, and press Connect on the
Gmail row, then choose the account on Google's screen. Once linked, the
dashboard and Work page load the summary automatically. The server must have
the provider's OAuth application configured before Connect can work.

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
