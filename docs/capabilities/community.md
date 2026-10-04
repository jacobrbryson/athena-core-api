---
id: community
title: Community
summary: I keep your points of interest, neighbors and local events — and watch around those places for emergencies and local news.
where: Companion → Community (sidebar; on the phone, Dashboard → Community card)
status: live
surfaces: [companion]
audiences: [adult]
triggers: [community, google contact, link contact, neighbor, neighbors, neighbour, next door, neighborhood, church, town, local event, ham day, festival, fair, parade, point of interest, points of interest, watched places, add a place, my town, school event, local news]
---

## What I can do

The Community page is where you tell me about the place you live, and I keep
all of it in mind whenever we talk:

- **Points of interest** — home, your church, the kids' school, the town
  square, a parent's house. Each has a kind, a ring on the map (1 to 10 miles)
  and notes. I keep watch around every one, all the time: a 911 call reported
  by PulsePoint Respond on your phone, or a severe-weather warning, inside a
  ring reaches you straight away. Any headline in the news pages you have me
  reading that mentions one of these places or its town shows up as local news.
- **Neighbors** — names, which house, which of your places they're near, a
  phone number or email if you want it kept, and notes (the kids' names, the
  dog, who has a generator). I'll know who you mean, and I think of them when
  something happens near home. You can link a neighbor to their entry in your
  Google Contacts: the card then shows their current phone, email, address and
  photo straight from Google, so a change there shows up here.
- **Local events** — church suppers, school fairs, town days like Ham Day: the
  day (or days), a time, where, a link and notes. Mark one "happens every year"
  and it comes round again — a week after, it's "last Saturday"; by winter it's
  next year's. I'll mention one when it genuinely fits, like when you're
  planning a free Saturday.

I never fill these lists by guessing: nothing is added from your contacts,
email or location history on its own — linking a contact is something you
pick. If you tell me about a new neighbor or event in
conversation, I'll suggest adding it on the Community page so I keep it.

## Where to find it

**Community** in the sidebar (on the phone, the Community card on the
Dashboard). Each list has its own **Add** button; every entry has **Edit** and
**Remove**. In a neighbor's form, **Google contact** searches your contacts as
you type (name, email or phone); pick one to link it, **Unlink** to undo. If
Google Contacts isn't connected, the same spot offers **Connect Google
Contacts**, which opens Connected apps. Points of interest are added by street address (Find) or **or use
my current location**, with a radius and a preview of the ring. The radius and
the **watching / paused** switch sit on each place. The same page shows what's
happening near your places, local news, and **Emergency alerts on this phone**
(PulsePoint access, location, and the test alerts).

## When it doesn't work

- **"I couldn't find that address":** the lookup only knows US street
  addresses. Check the street and town, or stand there and use your current
  location.
- **No local news:** I only see the news pages you've given me (News → Manage
  pages). Add your local paper or your town's news page — "Add a local news
  page" on the Community page opens the same list. A place whose address has no
  town, and a generic name like "Home", can't be searched for.
- **A neighbor's contact details went missing:** the card says why — the
  contact was deleted or merged in Google (edit and link it again), Google
  Contacts was disconnected (reconnect it in Connected apps), or Google
  couldn't be read just then (it comes back on its own). The link itself is
  kept.
- **An event disappeared from "Coming up":** a one-off moves to "Recently" once
  it's over. A yearly one moves to next year's date two weeks after.

## Limits

- I don't search the web for local news or events; local news is only what's
  in the pages I already read for you, and events are only the ones you add.
- I can't add, change or remove anything on this page for you — you do that on
  the page itself.
- Linking is read-only: I can't create or change a Google contact, and editing
  a neighbor here never touches Google.
- I don't suggest neighbors from your contacts by their address — you pick
  each link.
- A neighbor's phone number, email or linked contact details are on the page
  for you; in conversation I only know that they're in your contacts, not
  their details, and I never share a neighbor's details with
  anyone else.
- Up to 200 neighbors and 200 events. In conversation I see the first 25
  places, 40 neighbors, and events from two weeks ago to three months ahead.

## Under the hood

**Model use:** none on this page. The lists go into the adult chat prompt as a
"Their community" block on every turn (capped); nothing here calls a model.

- Service: `../../src/services/community.js` — neighbors/events CRUD,
  `occurrence()` (yearly roll-over), `pickLocal()` (headlines matched to place
  names/towns via `townOf()`), `overview()`, `promptBlock()`.
- Points of interest are `athena_watch_place` rows, owned by
  `../../src/services/pulsepoint/watch.js` (`kind`, `notes`, `PLACE_KINDS`);
  every kind is watched the same way. Saved through
  `PUT /api/v1/dashboard/incidents/places` (kind/notes omitted = kept).
- Google Contacts link: `athena_neighbor.contact_id` (People API id only;
  details are never copied). `searchContacts`/`withContacts` read through
  `../../src/services/connectors/googleContacts.js` `listContacts` (the guarded
  adapter, contacts.readonly), cached 5 min per profile. `linkStatus`:
  ok | missing | not_connected | unreadable — a failed read never drops a link.
- Controller/routes: `../../src/controllers/community.js`;
  `GET /api/v1/dashboard/community`, `GET /api/v1/dashboard/community/contacts?q=`, `POST|PATCH|DELETE
  /api/v1/dashboard/community/neighbors[/:uuid]`, same for `/events`.
- Chat: `../../src/controllers/gemini.js` appends `community.promptBlock` for
  adult, non-guardian sessions (owner asked that she always be aware).
- Migrations: `../../db/migrations/0050_community.up.sql` (`kind`/`notes` on
  `athena_watch_place`, `athena_neighbor`, `athena_community_event`) and
  `../../db/migrations/0051_neighbor_contact.up.sql` (`athena_neighbor.contact_id`).
- Frontend: `../../../companion/src/components/Community.tsx` (panels),
  `../../../companion/src/components/Dashboard.tsx` (CommunityPage),
  `../../../companion/src/components/EmergencyAlertSetup.tsx`.
- Tests: `../../src/services/community.test.js`.
- History: replaced the "Watched places" drawer in the profile menu
  (owner, 2026-10-04).
