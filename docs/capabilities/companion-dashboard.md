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

## Where to find it

After signing in to Companion, I open Home. On desktop, the left sidebar
contains Home, topic navigation and Talk to Athena. On mobile, the bottom bar
has Home, Chat, the central Athena button, Alerts (approvals), and More. Your
name at the bottom of the sidebar — or More on mobile — opens one menu holding
every setting and panel: memories, photos, brain, phone and car, local server,
actions, initiative, connected apps, voice, and sign out. In Chat, Daily
briefing opens a compact drawer with an Open full dashboard button.

## When it doesn't work

If I cannot check your connected apps, open Connected apps from your menu and
reconnect the provider there. A topic shortcut only fills the chat input; press
Send when you want my answer. If my card ordering is unavailable, the cards
appear in their standard order — nothing is hidden. Existing sign-in and access
requirements still apply.

## Limits

The landscape is decorative, not local weather. I never present sample personal
data as yours. Opening a card does not send a message or approve an action, and
ordering the cards never changes what is in them. My ranking is a reading order,
not advice, and it is refreshed periodically rather than on every glance, so it
can lag a change you just made. Live updates only reach a dashboard whose
connection is healthy; when the socket is down it falls back to re-reading
quietly in the background, which is slower but never wrong.

## Under the hood

- Frontend: `../../../companion/src/components/Dashboard.tsx`
- Shell and preserved chat: `../../../companion/src/pages/CompanionConsole.tsx`
- Styling: `../../../companion/src/dashboard.css`
- Card ordering: `../../src/services/dashboardPriority.js` via `GET /api/v1/dashboard/priority`.
- Live updates: `rpc: "dashboardUpdated"` from `../../src/websocket/wsServer.js`.
- Connection status: existing `GET /api/v1/integrations` through the shared client.
- The supplied sprite sheet is rendered with CSS background positions.
