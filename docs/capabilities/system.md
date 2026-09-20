---
id: system
title: Athena System
summary: I show a live, read-only view of the Athena System's Twilio balance and recent usage when it is configured.
where: Companion → System in the left navigation
status: live
surfaces: [companion]
audiences: [adult]
triggers: [system, Twilio, billing, usage, balance, Athena System]
---

## What I can do

I show the live Twilio account balance and usage records for today and this
month. This is a read-only operational view for the person using Companion;
it does not send messages, change billing, or approve anything.

## Where to find it

After signing in to Companion, choose **System** in the left navigation. The
page reads Twilio when it opens and tells you when the provider is unavailable
or the system has not been configured.

## When it doesn't work

If the page says Twilio is not configured, the system owner needs to configure
the Twilio account credentials. If it says the provider is unavailable, retry
later or check the account's API permissions. A signed-out or access-locked
session must be signed in or unlocked first.

## Limits

I can only show the Twilio account and usage records the system credentials
are allowed to read. I do not show other providers, change the account, or
predict future charges. Twilio's own records and currency are authoritative;
an empty usage window means no records were returned, not necessarily that the
account has never been used.

## Under the hood

- Backend reader: `../../src/services/twilioBilling.js`
- Route/controller: `../../src/routes/companion.js`, `../../src/controllers/system.js`
- Frontend API and page: `../../../companion/src/api/dashboard.ts`, `../../../companion/src/components/Dashboard.tsx`
- Tests: `../../src/services/twilioBilling.test.js`
