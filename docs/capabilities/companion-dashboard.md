---
id: companion-dashboard
title: Companion dashboard
summary: I offer a daily dashboard for your health, family, community, calendar, work, projects and memories — Health & Performance, then Family, then Community.
where: Companion → Dashboard; Chat → Daily briefing for the compact view
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [dashboard, briefing, today, home screen, navigation, order, community, neighborhood, nearby]
---

## What I can do

I populate the cards from connected sources: Google Calendar events for the next
seven days; dated WHOOP recovery, sleep and strain;
the linked Family Chores player's chores for today; saved family and work
memories; assigned Jira issues; unread Gmail headers; Slack mentions; and
pending action approvals. A missing connection, missing health consent, empty
result and failed read are distinct states. I do not invent missing metrics.

The Family card is one row per person I remember, most pressing first: someone
under the weather (with a Feeling better? button), a birthday in the next two
weeks, something on your calendar that names them, someone I haven't been told
about in three weeks (a nudge to update me and check on them), or someone I
barely know (a nudge to tell me more). The order is worked out by plain rules,
not by me guessing. It never goes quiet: with nobody remembered it asks you to
tell me about your family, and Add someone is always there. I can't see texts or
calls yet, so "staying in touch" means how long since you last told me about
someone, not when you last spoke.

Each person on the card carries a small tag for how they're related to you:
Spouse, Son, Daughter, Cousin, Pet, Child. I take it from how the memory is
filed ("spouse"), from a pet, or from what you told me ("Wynter is my
daughter") — never from someone else's mention ("lives near her son"). When I
don't know how someone is related to you, their row says so and the button opens
a chat where I ask, so I can fill it in.

Children on your family profiles appear on the card on their own, with their
birthday, and a child you have also told me about is one row, not two. On the
Family page, each person I remember has a Link contact button: search your
Google Contacts and pick the one that is them, and I read their birthday, photo
and phone number from there. Only the contact's ID and name are kept, so a
change in Google shows up on its own, and Unlink removes it. If Google Contacts
isn't connected, the same button offers to connect it. A contact can be linked
to only one person.

When the same person or pet has been remembered twice, or I filed something that
isn't a person ("Name", "Parents"), the Family page can tidy it. Merge on a
person asks who they should be folded into: what I know about them is added to
that person (nothing repeated, nothing lost), their Google Contact link moves
across if the target has none, and the duplicate is forgotten. Delete forgets an
entry after you confirm. Children from your family profiles can't be merged or
deleted here.

The News card and page show headlines I have already read for you in the
background, from pages you paste in News → Manage pages — no feed URL needed,
and no waiting on a website when you open the dashboard. How often I read each
page is mine to work out, not yours to set; news watching has its own
description. A page I could not read last time says so on the card. The
dashboard reads data; it never connects accounts or approves actions by itself.

I give you a responsive home screen with Health & Performance, Family,
Community, Calendar, Mail, Work, News & Updates, and Projects. The first three
follow your own hierarchy: take care of yourself, so you can take care of your
family, so your family can take care of the community. Calendar and health
cards check whether your apps are connected. Topic shortcuts open our chat
with an editable question; you choose when to send it. What is waiting for
your approval lives on the bell in the top bar, visible from any screen —
there is no separate Notifications card any more. The bell opens Notifications:
every proposal waiting for your approval, which you can approve or decline right
there, and the questions my dreaming left me holding, which I'll ask when you
tap Answer in chat. Its badge counts both. What I may do and what I have done
is one tap further, under Actions & permissions.

While your calendar says you're working, a banner sits across the top of the
Dashboard: where you're working ("Home"), until when, and the one thing the day
wants next — in the order a day goes: where you're working, the Jira ticket you
have in progress (if any; tap it to open it in Jira), then the next meeting and
how long you have before it. While you're in a meeting, that meeting comes
second and the ticket follows it. If nothing is in progress there is no ticket
block, and if nothing else is left before you finish it says so. It is
driven by the Working location you set in Google Calendar, not by the clock: no
location covering the moment, or an Out of office event over it, and there is no
banner, so a day off needs nothing from you. It appears and disappears on its
own at the start and end of that block. Only meetings inside the working block
count as "next meeting"; focus time and all-day markers don't.

"In progress" is Jira's own grouping, so it holds whatever your workflow calls
its statuses ("Code Review" counts); if several are in progress I show the one
you touched last and say how many more. Beside the banner, when Jira is
connected, a small chip says how many open issues are assigned to you and how
many are in progress — or, if any have a due date, how many are overdue or due
today. Tap it to open Work. When Jira has more than I read, the count reads
"25+" rather than claiming a total. If Jira isn't connected or can't be read,
neither the ticket nor the chip is there; the Work card says why.

The Community card shows what is happening around your points of interest —
nearby 911 calls and National Weather Service alerts, including the quiet ones
that never became a banner — and the next local event you've saved. The
Community page is where you keep your points of interest, neighbors and local
events (see Community). Family and
Work show up to three saved memories about people, pets, or work, explicitly
labeled as memories. Memories, photos, and connected apps have direct shortcuts
too. My controls provide hover, press, and keyboard-focus feedback. I respect
your device's reduced-motion preference by disabling interaction movement.

The cards are always in the same order: Health & Performance, Family,
Community, then the rest. Health leads with the verdict — GO, REST or WARNING
and the reasons behind it — then the last seven days of recovery and of sleep
as bars, so a bad day reads as a bad day or a trend — and keeps the individual
numbers behind Show the numbers. Calendar leads with what is on now or what is next and how long until
it starts (no drive time; I only know the place's name). On a phone each card
folds to its title and the one thing worth knowing — GO for Health, the next
event for Calendar, open mail, open issues — tap the title to open or fold it
and the headline to go to the page; I remember which you folded on that
browser. On a larger screen every card stays open. I don't re-sort them — you asked me not to. What I do read is the counts and
timings behind each card, to decide whether anything deserves the alert
banner across the top of the screen; most days nothing does.

There is no refresh button, because there is nothing to refresh by hand: the
dashboard updates itself when the server tells it something moved.

I reuse recently read information so reopening Dashboard or the daily briefing can
load faster. Routine background checks keep the cards steady while they load.
Changes announced by the server clear the previous view and request new data.

## Where to find it

After signing in to Companion, I open Dashboard. On desktop, the left sidebar
contains Dashboard, topic navigation and Talk to Athena. On mobile, the bottom bar
has Dashboard, Chat, the central Athena button, Alerts (notifications), and More. Your
name at the bottom of the sidebar — or More on mobile — opens one menu holding
every setting and panel: memories, photos, brain, phone and car, local server,
actions, initiative, connected apps, voice, and sign out. In Chat, Daily
briefing opens a compact drawer with an Open full dashboard button.
When Google provides a profile picture at sign-in, I show it beside your name
in the sidebar; if it cannot be loaded, I show your initial instead.

## When it doesn't work

When a card can't read a source, the fix is on the card, right under the line
that says so: "Google Calendar · Reconnect to refresh" carries a Reconnect
button that goes straight to that provider's sign-in and back (WHOOP recovery,
sleep and strain share one button), missing health consent carries Give
consent, and a failed read carries Retry. An app you never linked says "Not
connected" with a Connect button that goes straight to that provider, and
every card stays on the dashboard even when none of its apps are linked yet.
When the app shares health data (WHOOP) and you haven't agreed to that
yet, Connect and Give consent open Connected apps straight on that app's
consent prompt; "I agree — connect" then goes on to its sign-in. Nothing is
agreed for you — the prompt still waits for your tap. Section pages carry the same buttons in
the panel.

Empty cards say what would fill them, with the button that does: Add a news
page when you have none (and Fix this page when one stopped answering), Scan
more on an empty Mail card, Tell her about them when I know no family, Tell
her what you're working towards when there are no saved goals, Add a point of
interest on a Community card with no places, and Retry when memories,
nearby activity, approvals or news failed to load. A Tell her button only
starts our chat — nothing is saved until you say it.

If a Reconnect can't start from the card, I open Connected apps instead, which
says why. A topic shortcut only fills the chat input; press
Send when you want my answer. Existing sign-in and access
requirements still apply.

## Limits

News requires the news-watch database migration and its scheduled job; without
that job nothing is read and the card stays empty. Work OAuth apps
must be configured by the server owner and then authorized by the user. Provider
results are bounded previews, not complete exports. Dated health metrics may be
from earlier days; a missing score is displayed as unknown, never zero.

The landscape is decorative, not local weather. I never present sample personal
data as yours. Opening a card does not send a message or approve an action, and
I can't reorder the cards. Live updates only reach a dashboard whose
connection is healthy; when the socket is down it falls back to re-reading
quietly in the background, which is slower but never wrong.

Connected-provider reads may reuse results for up to 30 seconds, and my browser
can reuse dashboard reads for another 15 seconds. External changes appear on
the next refresh; background polling runs every five minutes. I reuse an alert
judgement only when its input signals match, for at most ten minutes. These
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
- Frontend: `../../../companion/src/components/Dashboard.tsx` (Community reads
  `GET /api/v1/dashboard/alert`, the incident watcher's stored situation, and
  `GET /api/v1/dashboard/community` — see `community.md`)
- Shell and preserved chat: `../../../companion/src/pages/CompanionConsole.tsx`
- Styling: `../../../companion/src/dashboard.css`
- Sidebar profile avatar: `../../../companion/src/components/ProfileAvatar.tsx`.
- Work banner: `../../../companion/src/components/WorkBanner.tsx`, logic and its
  tests in `workStatus.ts` / `companion/scripts/workStatus.test.mjs`
  (`npm run test:work`). Data: `workingLocations` on `GET /api/v1/dashboard`'s
  calendar source, split out of `events` in
  `../../src/services/connectors/googleCalendar.js` (`collectEvents`) — so the
  initiative triggers and chat prompt never see a location as a meeting either.
  Deploy core_api before the companion; an older API sends no locations and the
  banner simply stays hidden.
- Notifications panel: `../../../companion/src/components/NotificationsPanel.tsx`
  (approvals via `useActions`, questions via `../../../companion/src/athena/useDreamQuestions.ts`).
- Folding and headlines: `card()` and `headlines` in `Dashboard.tsx`; state in
  `localStorage` key `athena.dashboard.collapsed`; styles at the end of `dashboard.css`.
- Card order (fixed: health, family, community — owner removed the model
  ranking 2026-09-26 and set the hierarchy 2026-09-27)
  and the model's dashboard alert: `../../src/services/dashboardPriority.js` via
  `GET /api/v1/dashboard/priority`.
- Live updates: `rpc: "dashboardUpdated"` from `../../src/websocket/wsServer.js`.
- Connection status: existing `GET /api/v1/integrations` through the shared client.
- The supplied sprite sheet is rendered with CSS background positions.
