---
id: door-to-door
title: Door-to-door street check
summary: I help you check on everyone on your street in an emergency - list the houses ahead of time, then mark each one safe, no answer or needs help.
where: Companion → Community → Check on your street
status: live
surfaces: [companion]
audiences: [adult]
triggers: [door to door, door-to-door, check on neighbors, check on my neighbors, everyone safe, make sure everyone is safe, emergency, storm, power outage, street check, knock on doors, welfare check, evacuate]
---

## What I can do

I help you make sure everyone on your street is safe. Ahead of time, you list a
street: I find its houses on OpenStreetMap, a public map, and add any neighbors
you've saved that the map is missing. I put them in walking order, one side up
and the other side back.

When something happens, you open the street and go door by door. For each house
you tap Safe, No answer, Needs help or Skip, and you can type a note — who was
home, what they need. A house you've saved as a neighbor shows its household
name, contact line and notes. If anyone needs help, a red bar at the top lists
the house numbers with a Call 911 button.

Marks save on your phone first and are sent when there's signal, so a dead
network never loses one. You can see how many are waiting. When you've been
through the street, Finish this street keeps the record; you can reopen or
delete it any time.

## Where to find it

Companion → Community → **Check on your street**. **List a street** asks which
of your points of interest it is near and the street's name (it fills in from
that place's address), then **List this street**. Do this ahead of time, while
you have signal — a street that was never listed can't be fetched from a dead
network. **Start walking**, **Continue** or **Review** opens a street.

## When it doesn't work

- **The list is short or empty.** OpenStreetMap doesn't have every house on
  every street. Add the missing ones with the box under the list ("152 Rushing
  Water Lane"); they're kept for next time.
- **"The map data is busy" or "couldn't reach the map".** The public map server
  is rate-limited. Wait a minute and list the street again, or add houses by hand.
- **Marks say they're waiting to send.** There's no signal. They're safe on your
  phone and go through on their own when you're back online; keep this page or the
  app open.

## Limits

I never name, look up or guess who lives in a house — the list is addresses only.
Any names and notes are what you typed or saved yourself. I can't call, text or
alert anyone for you: "Call 911" is a button you press. I don't tell neighbors
you're coming. The street list is only as complete as the map and the neighbors you
saved, so treat it as a starting point, not a roll call, and go by what you see on the
street. Only the street's name and a point rounded to about a kilometre are sent to
OpenStreetMap; no house, name or note leaves my server.

## Under the hood

**Never sent to a model.**

- Backend: `../../src/services/doorToDoor.js` (Overpass lookup, rounds, marks),
  `../../src/controllers/doorToDoor.js`.
- Routes: `GET/POST /api/v1/dashboard/community/door-rounds`, `GET/DELETE
  .../:uuid`, `POST .../:uuid/{doors,sync,close}` in `../../src/routes/companion.js`.
- Migration: `../../db/migrations/0056_door_rounds.up.sql` (not applied by code;
  apply with `node db/migrate.js up 0056_door_rounds`).
- Frontend: `../../../companion/src/components/DoorToDoor.tsx`; pure offline
  logic and its tests in `doorMarks.ts` / `companion/scripts/doorMarks.test.mjs`
  (`npm run test:doors`). Mock: `../../../companion/mock/client.ts`.
- Tests: `../../src/services/doorToDoor.test.js`.
- Overpass answers 406 to a request with no identifying `User-Agent`; the service
  sends one. Results are cached in memory for an hour per street. A mark older than
  the one already stored for a house loses, so a late flush never overwrites a newer
  answer.
- The APK serves the UI from inside the app, so this needs an APK rebuild to reach
  the phone.
