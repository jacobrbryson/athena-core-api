---
id: nearby-incidents
title: Nearby emergencies
summary: I watch the county dispatch board and tell you when something serious is happening close to home.
where: Athena's notifications (in-app, phone, browser, text) and in conversation
status: live
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

`alertable` is **PulsePoint's own judgement**, tuned for a county-wide CPR
app. It turned out to be the wrong gate for "near my house" — see *How it
tells you* below — so it now only decides what may break quiet hours.

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

## How it tells you

`src/jobs/incidents.js` runs every two minutes (`athena-incidents`). Each pass
reads the county board once, finds active calls inside a watched radius, and
writes ONE `athena_nudge` (trigger `nearby_incident`) for the calls it has not
told you about in the last 24 hours. That row is the in-app card, and
`push.deliverNudge` fans it out to Android, browser and SMS. The text is
deterministic — no model call.

**What is told:** every locatable call in range except medical calls and a
few service codes (lift assist, public service). PulsePoint's `alertable`
flag is NOT the gate — it marks Tree Down and Hazardous Condition as
non-alertable, which is exactly what piled up near home on 2026-09-21 while
nothing was said. `alertable` only decides whether a call may break quiet
hours: a fire wakes you, a tree down waits until morning (still written
in-app immediately).

**In conversation:** `watch.promptBlock` puts the live nearby list into
Athena's system prompt (adult sessions, 2.5s bound), so she knows about it
without having pushed anything.

**Places:** `PULSEPOINT_WATCH_PLACES` JSON, plus the phone's latest location
sample if under 45 minutes old.

## Not built yet

- **Saved places table + panel** (home, family homes, each radius) — today
  it is an env var; needs a migration.
- **Phone location is on but no samples arrive**, so "near me" currently
  means near home only.
