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
- **Neighbors** — kept as households, by their address: one entry per house,
  with an optional name ("The Hendersons"), which of your places it's near, a
  description ("the blue house") and notes (the kids' names, the dog, who has a
  generator). Link everyone who lives there from your Google Contacts — as many
  people as the house has — and the entry shows each one's current phone,
  email and photo straight from Google, so a change there shows up here. When
  you type an address, I suggest the contacts whose Google address is that
  same house. I'll know who you mean, and I think of them when something
  happens near home.
- **Local events** — church suppers, school fairs, town days like Ham Day: the
  day (or days), a time, where, a link and notes. Mark one "happens every year"
  and it comes round again — a week after, it's "last Saturday"; by winter it's
  next year's. I'll mention one when it genuinely fits, like when you're
  planning a free Saturday.

The Community card and page also show what's on your Google Calendar in the next
seven days that mentions your community — "Soccer practice tomorrow night",
"Games Saturday", "5K Saturday night". I work out what counts as your community
from your points of interest: the town in each place's address, and a place's own
name when it's distinctive. I match those against the event's title, its
location and the calendar it sits on. I read your calendar for this on its own,
widely, so a week crowded with meetings doesn't push the games and the 5K out of
view. Games, practices, recitals, 5Ks and the like also count when they're for
someone in your family — "Softball game tonight · Skylar" — even if the event
never names the town. Nothing is tied to one town: add a point of
interest somewhere else and its events show up too. I only read the calendar for
this; I don't add or change anything on it.

I never fill these lists by guessing: nothing is added from your contacts,
email or location history on its own — a suggested contact is only linked
when you pick it. If you tell me about a new neighbor or event in
conversation, I'll suggest adding it on the Community page so I keep it.

## Where to find it

**Community** in the sidebar (on the phone, the Community card on the
Dashboard). Each list has its own **Add** button; every entry has **Edit** and
**Remove**. **Add a household** starts with the address (**Find** standardizes
it). Under **Who lives here**, contacts at that address are offered first; the
**Add someone from your Google contacts** box finds anyone else by name, email
or phone. **Unlink** takes a person off the house. A contact can only live at
one house — one already linked elsewhere says where. If Google Contacts isn't
connected, the same spot offers **Connect Google Contacts**, which opens
Connected apps. Points of interest are added by street address (Find) or **or use
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
- **"You already have a household at …":** each address is one house. Edit
  that one and add the people to it.
- **"… is already linked to …":** a contact lives at one house. Unlink them
  there first if they've moved.
- **A person's details went missing:** their row says why — the contact was
  deleted or merged in Google (unlink and link the new one), Google Contacts
  was disconnected (reconnect it in Connected apps), or Google couldn't be
  read just then (it comes back on its own). The link itself is kept.
- **No contacts suggested for an address:** I match the house number and
  street only, so the contact's address in Google has to be filled in and be
  the same house.
- **An event disappeared from "Coming up":** a one-off moves to "Recently" once
  it's over. A yearly one moves to next year's date two weeks after.

## Limits

- I don't search the web for local news or events; local news is only what's
  in the pages I already read for you, and events are only the ones you add.
- I can't add, change or remove anything on this page for you — you do that on
  the page itself.
- Linking is read-only: I can't create or change a Google contact, and editing
  a neighbor here never touches Google.
- I only suggest contacts for an address you've entered; I don't go looking
  through your contacts for neighbors on my own, and I never link one for you.
- A neighbor's phone number, email or linked contact details are on the page
  for you; in conversation I know the house and who lives there by name, not
  their details, and I never share a neighbor's details with anyone else.
- Up to 200 households (20 people each) and 200 events. In conversation I see the first 25
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
- Households: `athena_neighbor` keyed by `address_key` = `streetKey()` (street
  line, normalized: "Lane" = "LN"); unique per profile. Links in
  `athena_neighbor_contact` (People API id + display-name snapshot for the
  prompt; unique per profile+contact, so a contact is at one house).
  `saveNeighbor` takes the whole `contacts` set. `searchContacts`,
  `contactsAtAddress` and `withContacts` read through
  `../../src/services/connectors/googleContacts.js` `listContacts` (the guarded
  adapter, contacts.readonly), cached 5 min per profile. Per-contact `status`:
  ok | missing | not_connected | unreadable — a failed read never drops a link;
  a renamed contact refreshes its snapshot.
- Controller/routes: `../../src/controllers/community.js`;
  `GET /api/v1/dashboard/community`, `GET /api/v1/dashboard/community/contacts?q=`, `GET …/contacts/at?address=`, `POST|PATCH|DELETE
  /api/v1/dashboard/community/neighbors[/:uuid]`, same for `/events`.
- Chat: `../../src/controllers/gemini.js` appends `community.promptBlock` for
  adult, non-guardian sessions (owner asked that she always be aware).
- Migrations: `../../db/migrations/0050_community.up.sql` (`kind`/`notes` on
  `athena_watch_place`, `athena_neighbor`, `athena_community_event`) and
  `../../db/migrations/0051_neighbor_contact.up.sql` (single `contact_id`,
  superseded) and `../../db/migrations/0053_neighbor_household.up.sql`
  (address key, coordinates, `athena_neighbor_contact`; moves 0051 links).
- Frontend: `../../../companion/src/components/Community.tsx` (panels),
  `../../../companion/src/components/Dashboard.tsx` (CommunityPage),
  `../../../companion/src/components/EmergencyAlertSetup.tsx`.
- Tests: `../../src/services/community.test.js`.
- History: replaced the "Watched places" drawer in the profile menu
  (owner, 2026-10-04).
