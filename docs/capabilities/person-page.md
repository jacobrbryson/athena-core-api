---
id: person-page
title: A page for each person
summary: Each person and pet in the family has a page of their own — upcoming events, health, memories, photos, interests and related people.
where: Companion dashboard → Family → tap a person under Family Members, or their name in People & pets → their page
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [person page, profile page, about them, their page, interests, favorites, related people, what do you know about, family member page]
---

## What I can do

Each person and pet on the Family page has a page of their own. At the top:
their photo, how they're related to you, their age and grade when I know
them, their next birthday, and a few chips — an event soon, a birthday
coming, healthy or on a health watch — with my take on what matters about
them right now.

The Overview gathers:

- **Today & Upcoming** — calendar events in the next 30 days that name them,
  and their birthday.
- **Health** — their active health watches (tap one to open it), with a
  button to start a new one; the Health tab also lists past watches.
- **About** — a short write-up you can edit, their grade (which you can
  set under Edit, and which moves up by itself every August 1st), age,
  birthday, relation (which you can correct), and how much I remember about
  them.
- **Memories** — conversations, photos and notes that mention them, and the
  details filed under their memory.
- **Photos** — photo memories that mention them.
- **Chores** — Family Chores chores whose title names them.
- **Interests & Favorites** — things they love, which you add and remove.
- **Related People** — who they are to each other ("Brother", "Mom"), which
  you add; tapping one opens that person's page.
- **Details & Connections** — where my information comes from: their Google
  Contact, an Athena child profile, the family account, health watches, the
  calendar, my memories, and camera sightings.

Tabs (Memories, Health, Activities, Photos, Details) show the full lists.

## Where to find it

Companion dashboard → **Family** → tap anyone under **Family Members** →
their page (`/family/people/<id>`). In the **People & pets** panel (the
Alerts tile, or **View all**), tap a person's name, or choose **Open page**
from their **⋯** menu. **← Family** goes back. **Edit memory, contact & birthday** under Details & Connections
opens the same editor the Family page used to open.

## When it doesn't work

- **A calendar event or memory about them is missing** — I find those by
  their name in the event title or the memory's words. A nickname or "my
  daughter" alone won't match; say their name.
- **A photo shows only words** — the picture lives on the device that took
  it; on another device you see my description instead.
- **No chores** — Family Chores doesn't record whose chore is whose. Only
  chores that name them in the title show.

## Limits

- Interests and related people are what you add here. I don't fill them in
  from conversation yet.
- Matching is by name, so two people who share a first name can see each
  other's events or memories. The family's shared surname is never used to
  match.
- Messages aren't shown per person yet.
- The grade moves up one each school year (August 1st) — a kid held back or
  skipped ahead needs it set again. A grade on an Athena child profile that
  was never set on this page doesn't move up, and the Family list still
  shows the child profile's own grade.
- It's per account: what you write about someone is yours, not shared with
  the rest of the family.

## Under the hood

- Frontend: `../../../companion/src/components/PersonPage.tsx` (+ `person.css`),
  routed from `../../../companion/src/components/Dashboard.tsx`
  (`PersonDetailPage`, `/family/people/:key` in `dashboardRoutes.ts`/`App.tsx`);
  the Family page's member tap now navigates there.
  `../../../companion/src/components/familyRoster.ts` exposes each row's match
  `tokens` and `childUuid`.
- Backend: `../../src/services/personPage.js`, `../../src/controllers/personPage.js`
- Routes: `GET|PATCH /api/v1/dashboard/family/person/:key` (`names` = the
  roster's match tokens, max 4), `POST …/:key/interests`,
  `DELETE …/:key/interests/:uuid`, `POST …/:key/related`,
  `DELETE …/:key/related/:uuid`. `:key` is a `user_memory.uuid` of the
  caller's (family/person/pet category) or `child:<child_profiles.uuid>` in
  their family — checked on every call.
- Data: migration `0122_person_page` — `athena_person` (write-up, relation
  override; `grade` + `grade_year` from `0123_person_grade`, advanced on read
  by `currentGrade()`), `athena_person_interest`, `athena_person_relation`, keyed by
  `(profile_id, person_key)`. Everything else is read where it lives:
  `user_memory`, `memory_event` (name match, whole-word filter),
  `family_health_status`, `athena_sighting_person_link` + `athena_sighting`,
  Google Contacts via `familyPeople`.
- Athena's Take on the page is computed from the roster's signals — no
  model call.
- Tests: `../../src/services/personPage.test.js`
