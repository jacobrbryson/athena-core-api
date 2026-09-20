---
id: right-now
title: What To Do Right Now
summary: I can look at the hours in front of you and tell you one thing worth doing with them — the trails if they're open, or something at home if they're not.
where: the Dashboard — it sits above your cards, and "Places & projects" opens the lists behind it
status: planned
surfaces: [companion]
audiences: [adult]
triggers: [what should i do, free afternoon, is the park open, park hours, trails open, mountain bike, go for a ride, nothing to do, bored, what do you think i should do, spare time, is it open, hiking, kill some time]
---

## What I can do

I take the gap in front of you — the time until your next appointment — and
weigh it against the places you've told me you go and the projects waiting at
home, and I put **one** suggestion at the top of your dashboard, with a second
one of a different kind underneath it.

For a place, I read its own web page on a rhythm and keep what it says: open or
closed, today's hours, and whether those hours depend on the weather. If you
have Strava linked and you've said yes to health data, I also know what you
actually do — that you ride most Sundays, that you haven't yet this week — and
that's usually the reason I'll give you. Where a place has weather-dependent
hours and I know where it is, I check the forecast for that spot.

Everything I claim is shown with the thing it came from: the closing time, the
distance you typed, the habit, the sky. If I can't reach a model I'll still
rank your own lists and tell you so.

## Where to find it

It's the first block on your Dashboard, above the cards. The **Places &
projects** button on it — also at the bottom of the dashboard — opens the two
lists:

- **Places**: paste the address of a park, a pool, a trailhead, say what it's
  for ("mountain biking") and roughly how far it is. I read the page once
  straight away and then on my own schedule, about twice a day.
- **Projects**: the work around the house. Hours and indoors-or-out are the two
  details that matter most — one decides what fits your afternoon, the other
  decides what I suggest when it rains. If your list is in a spreadsheet,
  "Bring in a spreadsheet" takes a paste of it and shows you what it made of
  your columns before anything is saved.

## When it doesn't work

- **I say I can't tell whether somewhere is open.** That means the page didn't
  say, and I won't guess — a page that never states a status is not the same as
  one that says open. Press "check now" in the Places list; if it keeps
  happening the page probably hides its hours behind a script I can't read, and
  a different page on the same site may work better.
- **Nothing is suggested at all.** Either both lists are empty, you're in the
  middle of something on the calendar, or everything was ruled out — in which
  case I say which thing and why, rather than going quiet.
- **I don't mention your habits.** I only know them if Strava is connected and
  health data is consented. Without that I still use the hours, the weather and
  your calendar.

## Limits

- I can't book, drive, or tell anyone you're coming. This is a suggestion, and
  it's the only thing it is.
- I don't know where you are. The distance is the number you typed, and the
  forecast is for the place, not for you.
- I only know what a place's page says. A gate closed this morning that nobody
  has posted about is a gate I'll tell you is open.
- I don't watch the weather anywhere outside the United States — the service I
  use is the US National Weather Service, and elsewhere I simply say nothing
  about it rather than guessing.
- I won't add, finish, or remove anything on either list myself.

## Under the hood

**Never sent to a model.** The map for the next coding agent:

- Backend: `src/services/rightNow.js` (candidates, scoring, the one
  model call), `src/services/places.js` (fetch + interpret + opening
  hours), `src/services/weather.js` (NWS, no key, null on failure)
- Frontend: `../../../companion/src/components/RightNowCard.tsx`,
  `../../../companion/src/components/PlansPanel.tsx`
- Routes: `GET /api/v1/dashboard/right-now`, `GET|POST /api/v1/dashboard/places`,
  `PATCH|DELETE /api/v1/dashboard/places/:uuid`, `POST /api/v1/dashboard/places/:uuid/check`
  — all in `src/controllers/rightNow.js`, all behind `requireAdultActor`
- Schema: `db/migrations/0037_right_now.up.sql`
- Job: the opening-hours pass rides along with `src/jobs/news.js`
  (`--no-places` skips it) rather than adding a second scheduled process
- Tests: `src/services/rightNow.test.js`, `src/services/places.test.js`
- Notes: `openNow` is three-valued and `null` must never render as open — that
  rule is enforced in `placeCandidates`, not in the prompt. The model only ever
  chooses between candidate ids built here; an id it invents fails the check and
  the deterministic ranking ships instead. Strava is read for 90 days (the
  dashboard's own read is 7) and only after an active link AND health consent.
  The mock at `../../../companion/mock/client.ts` carries the full worked example.
