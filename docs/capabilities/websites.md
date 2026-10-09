---
id: websites
title: Websites
summary: I keep a list of the websites you manage and show how each is doing, from your Google Search Console and Analytics.
where: Companion → Projects → Websites (connect it under ⋯ menu → Connected apps → Google → Websites)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [website, websites, my site, my sites, search console, google analytics, analytics, ga4, traffic, visitors, page views, clicks, impressions, search ranking, seo, athena-learning.app, family-chores.app, orcwood, rossbryson]
---

## What I can do

You can give me the websites you manage, and for each one I read, from Google,
how it's doing:

- **Search Console** — clicks and impressions from Google Search over the last
  week, how that compares with the week before, and the searches people used
  to find it.
- **Analytics (GA4)** — visitors, visits and new visitors over the last week
  against the week before, and the most-viewed pages.

Each number comes with its change from the week before. If a site has no
Search Console or Analytics property yet, I show what I have for it and say what
is missing — I never fill a gap with a guess.

I only read. I can't change anything on your sites, in Search Console, or in
Analytics.

## Where to find it

First connect it: the **⋯ menu in the top right** → **Connected apps** → the
**Google** card → the **Websites** row → **Connect**. Google asks you to approve
read-only access to Search Console and Analytics. If you signed in with Google
before this existed, you'll need to approve it once more.

Then open **Projects** and look for the **Websites** panel. **Add a website**
lists the properties Google says you can see so you can pick the right Search
Console site and Analytics property rather than typing ids. **Check now** reads
Google again; each site also has **Edit** and **Remove**.

## When it doesn't work

- **The panel says Websites isn't connected, or says reconnect.** Use the same
  Connected apps row. Approving again also picks up Search Console and Analytics
  if you skipped them the first time.
- **A site shows a message from Google instead of numbers.** I show Google's own
  words. The usual causes: the Google account I'm linked to isn't an owner or
  user of that property, or the Search Console API or Analytics Data/Admin API
  hasn't been switched on in the Google Cloud project. I keep the last good
  numbers rather than replacing them with zeros.
- **Search numbers are a few days old.** Google Search Console reports with a
  delay of about two to three days, so its week ends a few days ago.
- **A site has Analytics but no search numbers, or the reverse.** Each source
  needs its own property on the site's entry — use **Edit**.

## Limits

- Read-only.
- Only sites in the Google account I'm linked to; one Google account.
- Visitor numbers come from Google Analytics: they include only people whose
  browsers allow it, and they aren't a count of accounts or signups.
- Up to 50 websites.
- I don't yet bring these numbers into our conversations or tell you when
  something changes; for now they're on the panel.

## Under the hood

- Connector: `src/services/connectors/googleWebsites.js` — Search Console
  `searchAnalytics/query` and GA4 `runReport`, `accountSummaries` for discovery.
  Per-site reads pass `invalidateOnAuthFailure:false`: one property's 403 must
  not flag the whole link `needs_reauth`.
- Descriptor: `websites` in `src/services/connectors/registry.js` (a member of
  the `google` group; scopes `webmasters.readonly`, `analytics.readonly`).
  Three named hosts in `apiBases`, picked with `{ api: "search" | "analytics" |
  "admin" }` on `providerRequest` in `src/services/connectors/http.js`; a
  caller never supplies a host.
- Service: `src/services/websites.js` — site CRUD, `discover`, `refresh`,
  week-on-week `change`. Snapshots are one row per site, source and day.
- Controller/routes: `src/controllers/websites.js`;
  `GET|POST /api/v1/dashboard/websites`, `GET …/discover`,
  `POST …/refresh`, `PATCH|DELETE …/:uuid`, `POST …/:uuid/refresh`. Manual
  refresh is throttled to one per minute per site per person.
- Migration: `../../db/migrations/0057_websites.up.sql`
  (`athena_site`, `athena_site_snapshot`).
- Frontend: `../../../companion/src/components/Websites.tsx`, mounted on
  `ProjectsPage` in `../../../companion/src/components/Dashboard.tsx`.
- Tests: `src/services/websites.test.js`,
  `src/services/connectors/googleWebsites.test.js`.
- Not built yet: the nightly snapshot job, chat context, initiative triggers,
  and first-party user counts (Family Chores, Orcwood — Orcwood via a
  Cloud Run IAM-protected stats endpoint, owner decision).
- Google Cloud: Search Console API, Analytics Data API and Analytics Admin API
  must be enabled in project `athena-476423`, and the sensitive scopes added to
  the OAuth consent screen.
