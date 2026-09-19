---
id: companion-dashboard
title: Companion dashboard
summary: I offer a daily dashboard for your calendar, health, family, work, projects, memories and approvals, ordered by what I think matters most today.
where: Companion → Home; Chat → Daily briefing for the compact view
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [dashboard, briefing, today, home screen, navigation, priority, order]
---

## What I can do

I populate the cards from connected sources: Google Calendar events for the next
seven days; dated WHOOP recovery, sleep and strain; recent Strava activities;
the linked Family Chores player's chores for today; saved family and work
memories; assigned Jira issues; unread Gmail headers; Slack mentions; and
pending action approvals. A missing connection, missing health consent, empty
result and failed read are distinct states. I do not invent missing metrics.

The News card and page show headlines I have already read for you in the
background, from pages you paste in News → Manage pages — no feed URL needed,
and no waiting on a website when you open the dashboard. How often I read each
page is mine to work out, not yours to set; news watching has its own
description. A page I could not read last time says so on the card. The
dashboard reads data; it never connects accounts or approves actions by itself.

I give you a responsive home screen with Calendar, Health & Performance,
Family, Work, News & Updates, Projects, and Notifications. Calendar and health
cards check whether your apps are connected. Topic shortcuts open our chat
with an editable question; you choose when to send it. Notifications shows what
is waiting for your approval and opens the approval panel; its count also
appears on a bell in the top bar, so you can see it from any screen. Family and
Work show up to three saved memories about people, pets, or work, explicitly
labeled as memories. Memories, photos, and connected apps have direct shortcuts
too. My controls provide hover, press, and keyboard-focus feedback. I respect
your device's reduced-motion preference by disabling interaction movement.

I also decide the order the cards appear in. I read the counts and timings
behind each card — how soon your next event starts, how many approvals are
open, whether a source is connected at all — and rank them, with a one-line
reason shown on whichever card I put first. I never add or remove a card by
doing this; if I cannot rank them, they stay in their usual order and I say
nothing about it.

There is no refresh button, because there is nothing to refresh by hand: the
dashboard updates itself when the server tells it something moved.

I reuse recently read information so reopening Home or the daily briefing can
load faster. Routine background checks keep the cards steady while they load.
Changes announced by the server clear the previous view and request new data.

## Where to find it

After signing in to Companion, I open Home. On desktop, the left sidebar
contains Home, topic navigation and Talk to Athena. On mobile, the bottom bar
has Home, Chat, the central Athena button, Alerts (approvals), and More. Your
name at the bottom of the sidebar — or More on mobile — opens one menu holding
every setting and panel: memories, photos, brain, phone and car, local server,
actions, initiative, connected apps, voice, and sign out. In Chat, Daily
briefing opens a compact drawer with an Open full dashboard button.
When Google provides a profile picture at sign-in, I show it beside your name
in the sidebar; if it cannot be loaded, I show your initial instead.

## When it doesn't work

If I cannot check your connected apps, open Connected apps from your menu and
reconnect the provider there. A topic shortcut only fills the chat input; press
Send when you want my answer. If my card ordering is unavailable, the cards
appear in their standard order — nothing is hidden. Existing sign-in and access
requirements still apply.

## Limits

News requires the news-watch database migration and its scheduled job; without
that job nothing is read and the card stays empty. Work OAuth apps
must be configured by the server owner and then authorized by the user. Provider
results are bounded previews, not complete exports. Dated health metrics may be
from earlier days; a missing score is displayed as unknown, never zero.

The landscape is decorative, not local weather. I never present sample personal
data as yours. Opening a card does not send a message or approve an action, and
ordering the cards never changes what is in them. My ranking is a reading order,
not advice, and it is refreshed periodically rather than on every glance, so it
can lag a change you just made. Live updates only reach a dashboard whose
connection is healthy; when the socket is down it falls back to re-reading
quietly in the background, which is slower but never wrong.

Connected-provider reads may reuse results for up to 30 seconds, and my browser
can reuse dashboard reads for another 15 seconds. External changes appear on
the next refresh; background polling runs every five minutes. I reuse a card
ordering only when its input signals match, for at most ten minutes. These
caches do not reuse our chat replies or approve anything. Browser copies stay
in memory and are cleared on sign-in, sign-out, access errors, and updates.

## Under the hood

- Encrypted database cache and bounded API memory: `../../src/services/readCache.js`;
  migration `../../db/migrations/0034_read_cache.up.sql`.
- Browser read reuse: `../../../companion/src/api/readCache.ts` and
  `../../../companion/src/components/useDashboardData.ts`.
- Freshness, invalidation, rollout and diagnostic counters: `../architecture/caching.md`.

- Data endpoint: `../../src/controllers/dashboard.js` and `../../src/services/dashboard.js`.
- News: `../../src/services/news/`, described in `news.md`. The card and page
  only render what that service has already stored.
- News source UI: `../../../companion/src/components/NewsSourcesPanel.tsx`.
- Migrations: `../../db/migrations/0031_dashboard_preferences.up.sql` (the
  legacy news source list, now read once to adopt it) and
  `../../db/migrations/0032_news_watch.up.sql`.
- Work connectors: `../../src/services/connectors/work.js`.
- Frontend: `../../../companion/src/components/Dashboard.tsx`
- Shell and preserved chat: `../../../companion/src/pages/CompanionConsole.tsx`
- Styling: `../../../companion/src/dashboard.css`
- Sidebar profile avatar: `../../../companion/src/components/ProfileAvatar.tsx`.
- Card ordering: `../../src/services/dashboardPriority.js` via `GET /api/v1/dashboard/priority`.
- Live updates: `rpc: "dashboardUpdated"` from `../../src/websocket/wsServer.js`.
- Connection status: existing `GET /api/v1/integrations` through the shared client.
- The supplied sprite sheet is rendered with CSS background positions.
