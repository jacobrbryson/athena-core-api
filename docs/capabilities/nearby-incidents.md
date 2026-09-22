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
tells you* below — so it now only feeds the level: a serious call is urgent
on its own.

## Under the hood

**Model use:** only the situation assessment (headline, body, level), once per
change, through the normal access gate; the fetch, the radius check and the
floor are rules. Background calls are charged to `ATHENA_BACKGROUND_GOOGLE_ID`.

- Service: `../../src/services/pulsepoint/` — `fetch.js` (the call and the
  decrypt), `normalise.js` (their shape to ours), `geo.js` (great-circle
  distance and the radius check), `calltypes.js` + `calltypes.json` (what a
  code means).
- Job: `../../src/jobs/incidents.js`; situation, feed health and alert in
  `watch.js`; banner in `../../../companion/src/components/EmergencyBanner.tsx`.
- Tests: `../../src/services/pulsepoint/pulsepoint.test.js` — pure, no network.
- Politeness: one request per poll, well under the rate their own web app uses,
  an honest User-Agent, a hard timeout, a capped read. This is an undocumented
  endpoint belonging to someone else, serving public-safety data at their
  expense. If they ask us to stop, we stop.

## How it tells you

It is meant to be a big deal. On 2026-09-21 a structure fire and several
trees down sat within two miles of home while nothing was said, and the owner's
instruction afterwards was that an emergency nearby should be all Athena wants
to talk about.

**The situation, judged once.** `src/jobs/incidents.js` runs every two
minutes (`athena-incidents`). When the set of nearby active calls changes, the
model is shown them and decides how loud to be (`none` / `watch` / `urgent`)
and what to say. Underneath it is a floor it cannot go below: **two or more
calls, or any serious one, is urgent**; one routine call is watch. The answer
is checked — with three calls or fewer it must name every one, or the router
moves on to a stronger model — and if no model answers in 25 seconds the
rules' own wording goes out. The result is stored in
`athena_incident_situation`, and every surface reads that one judgement.

**Everywhere at once.** Each new call becomes one `athena_nudge`
(trigger `nearby_incident`): the in-app entry, plus push and text through
`push.deliverNudge`. Urgent ignores quiet hours; a lone watch-level call waits
for morning. When an urgent situation ends, an all-clear goes out.

**In the app.** A banner across the top of every screen
(`GET /dashboard/alert`, polled each minute and on resume): huge and red when
urgent, with every call, distance, units and time. "Got it" shrinks it to a
bar that stays until the situation ends; in chat it is pinned under the top
bar. On sign-in, Athena's spoken greeting is the emergency instead of
"welcome back". The dashboard's own model call (`dashboardPriority`) also
sees the situation and may raise an alert about anything on the dashboard; it
cannot lower an emergency.

**In conversation.** `watch.promptBlock` puts the situation in Athena's
system prompt. When urgent it tells her to open every reply with it until
it is acknowledged.

**The feed itself.** `athena_incident_feed` tracks every read. Three misses in
a row (six minutes) is an outage: the owner is told once, the banner says the
watch is offline, and Athena knows she cannot see the board.

**What is told:** every locatable call in range except medical calls and a
few service codes (lift assist, public service). PulsePoint's own
`alertable` flag is not the gate — it marks Tree Down and Hazardous Condition
as non-alertable.

**Places:** `athena_watch_place` (home, family homes; `/dashboard/incidents/places`),
plus the phone's latest location sample if under 45 minutes old.

## Known gaps

- **No phone position reaches the server.** `POST /location/sample` exists
  and the location switch saves a preference, but nothing sends samples: the
  Android app has no location permission or reporter. "Near me" is therefore
  "near my saved places" until that native work ships.
- **Texts are blocked by carriers.** Twilio accepts them and reports
  `undelivered` with error 30034 — the sending number is not registered for
  US A2P 10DLC. Nothing in code can fix that; the Twilio account needs a
  registered campaign or a verified toll-free number.
- **No places panel yet.** Places are editable through the API only.
