---
id: nearby-incidents
title: Nearby emergencies
summary: I watch the county dispatch board and tell you when something serious is happening close to home.
where: not yet on a surface — service layer only
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [emergency, fire, sirens, what happened, police, ambulance, dispatch, scanner, pulsepoint, nearby, down the street, what was that]
---

## What this is for

One sentence, from the person who asked for it: *if there is an emergency
within three miles of me I want to know about it, and what it is.*

Not a scanner feed to browse. A short, rare, specific interruption — "confirmed
structure fire, half a mile from home, four units" — and silence the rest of
the time.

## Why it is not a news source

The obvious move is to paste `web.pulsepoint.org` into the news watcher. That
can never work, and it is worth writing down so nobody tries it twice. The page
is a 1.3 KB shell that builds itself in the browser; the news watcher reads
finished HTML. It is the exact case `news.md` lists as permanently out of
reach. A source added that way would say *Couldn't read it last time* forever.

## Where the data comes from

PulsePoint's own web client calls `api.pulsepoint.org/v1/webapp?resource=incidents&agencyid=…`
and gets back `{ct, iv, s}` — AES-256-CBC, with the key stretched from a
passphrase by OpenSSL's EvpKDF (MD5, one iteration) over the salt. The
passphrase is assembled at runtime from characters of a string literal, and all
of it ships in the clear in their public bundle. `fetch.js` rebuilds it the same
way. There is no credential, no account, and nothing defeated: this reads a
response that is served to any browser that asks.

**The agency is `EMS1681` — Iredell Emergency Communications ("Iredell 911").**
It dispatches *both fire and EMS* for all of Iredell County, NC, so it is the
only agency id needed; there is no separate fire department to add.

### Re-extracting the call-type table

`calltypes.json` is lifted from their bundle, where the codes appear as
`{id:"SF",description:"Structure Fire",category:"Fire",alertable:!0}`. To
refresh it, fetch `web.pulsepoint.org`, follow the `main.*.js` script, and:

```bash
grep -oE '\{id:"[A-Z0-9]{1,6}",description:"[^"]+",category:"[^"]+",alertable:![01]\}' main.js \
 | sed -e 's/{id:/{"id":/' -e 's/,description:/,"description":/' \
       -e 's/,category:/,"category":/' \
       -e 's/,alertable:!0}/,"alertable":true}/' -e 's/,alertable:!1}/,"alertable":false}/' \
 | paste -sd',' - | sed -e 's/^/[/' -e 's/$/]/'
```

112 codes across 17 categories at the time of writing, 52 of them alertable.

## The two facts that shape the design

Both were measured against a live sample of 115 incidents, not assumed.

**Coordinates arrive as strings** — `"35.5826600000"`. Parsed once, in
`normalise.js`.

**Medical calls have their coordinates redacted to `0,0`** and their address
truncated to a road name. This is PulsePoint protecting the person having the
emergency. The split against that sample was total:

| | real coordinates | redacted |
|---|---|---|
| alertable calls | 15 | 0 |
| routine calls | 22 | 68 (all medical) |

So the radius filter needs no geocoder. Everything that would interrupt you can
be placed exactly; the calls that cannot be placed are the ones nobody should
be able to place. A redacted incident is kept and named, carries
`locatable: false`, and can never match a radius.

`alertable` is **PulsePoint's own judgement**, not ours — made by people who do
this for a living. We do not second-guess it. An unknown code is never
alertable, because "something is happening nearby and I do not know what" is
the one message that worries without informing.

## Under the hood

**Never sent to a model.**

- Service: `../../src/services/pulsepoint/` — `fetch.js` (the call and the
  decrypt), `normalise.js` (their shape to ours), `geo.js` (great-circle
  distance and the radius check), `calltypes.js` + `calltypes.json` (what a
  code means).
- Tests: `../../src/services/pulsepoint/pulsepoint.test.js` — 19, all pure, no
  network.
- Politeness: one request per poll, well under the rate their own web app uses,
  an honest User-Agent, a hard timeout, a capped read. This is an undocumented
  endpoint belonging to someone else, serving public-safety data at their
  expense. If they ask us to stop, we stop.

## Not built yet

The service layer reads, decodes, names and locates incidents, end to end,
against live data. Nothing yet decides *whom to tell and how*:

- **Saved places.** Home and family members' houses, each with its own radius.
  Needs a migration and a panel; `geo.placesNear` already takes the list.
- **Live phone location.** The companion does not report position at all today.
  Biggest remaining piece.
- **The poll job.** `src/jobs/` schedule, plus dedupe so one fire is one alert.
- **Delivery.** Push exists (`services/push`, android/car only — web has no
  transport). In-app and conversational mention follow the news pattern.
  **Text message has no provider anywhere in the project** — it needs an
  account, a number and credentials before a line of code is worth writing.
