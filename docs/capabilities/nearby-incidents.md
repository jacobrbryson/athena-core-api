---
id: nearby-incidents
title: Nearby emergencies
summary: I watch the county dispatch board and tell you when something serious is happening close to home.
where: Athena's notifications (in-app, phone, browser, text), the alert banner, in conversation; places under your menu → Watched places
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

**Places:** your menu → **Watched places** (`companion/src/components/PlacesPanel.tsx`):
home, family homes, each with its own radius (1–10 mi), pausable. Add one by
street address — looked up server-side against the free US Census geocoder
(`src/services/pulsepoint/geocode.js`, US street addresses only, no business
names) — or "use my current location". A new place is checked immediately.
Stored in `athena_watch_place`, plus the phone's latest location sample if
under 45 minutes old.

**Maps.** Every alert carries its calls' positions: the banner and each
emergency message in the chat thread show a small OpenStreetMap map
(`MiniMap.tsx`) with a numbered pin per call and the ring of each watched
place. No map library — positioned tiles and Web Mercator maths. Nudges
expose only the pins (`initiative.nudgeMap`); the rest of `facts` never leaves
the server.

## The weather half

The National Weather Service (`nws.js`, api.weather.gov) is the second source:
official, free, no key, and it answers "what covers this exact point", which is
the shape a watched place already has. NWS grades its own alerts and that
grading is used as-is — urgent needs a serious severity (Extreme/Severe) AND a
clock that has started (Immediate/Expected), so a tornado *warning* is urgent
while a tornado *watch* is not. Advisories (Minor), tests, cancellations and
expired alerts never appear.

## Rhythm and sources

The scheduler ticks every 5 minutes; the rhythm is decided in `watch.js`:
every **15 minutes** when quiet, every **5 for an hour** once something new
comes up nearby (each new thing extends the hour), and every **6 hours** for a
source that is blocking automated readers. Due-times are measured by the
database (`TIMESTAMPDIFF`), never by comparing the container's clock to
database timestamps.

Health is per source (`athena_incident_source`): the 911 board being blocked
says nothing about the weather service, and the banner and Athena both say
which half is blind. **A source that could not be read is "unknown", never
"all clear"** — the calls already known are carried forward untouched, and an
all-clear can only be sent when everything was actually read.

## PulsePoint blocked us (2026-09-22)

From ~14:12 UTC the incident endpoint answers 202 with
`x-amzn-waf-action: challenge` from every IP: PulsePoint turned on AWS WAF bot
protection. **This is not to be worked around** — no browser user-agent, no
solving the challenge, no rotating IPs. `fetch.js` flags it, the watcher tells
the owner once, backs off to one retry every 6 hours and exits 0 so the job
stops reading as failed. It recovers by itself if the block is lifted.

The sanctioned replacement is the **PulsePoint Respond** app, which any member
of the public can use (agency affiliation only gates the CPR responder tiers).
Its notifications are per incident type across the whole agency, not a radius.

## 911 calls after the block: the phone forwards PulsePoint's own alerts

PulsePoint Respond (`mobi.firedepartment`) is open to any member of the public
and notifies about chosen incident types across the whole agency. The Athena
Android app reads THOSE notifications — `PulsePointListener`, a
NotificationListenerService that ignores every other app's notifications — and
posts title and text to `POST /api/v1/dashboard/incidents/phone-alert`
(device-token authenticated, like location samples). Notification access is
granted by the owner in Android settings, revocable there, and offered in the
Watched places panel.

`phoneAlerts.js` turns that line of text back into an incident: the call type
by matching PulsePoint's own 112 names, the position by geocoding the address,
and then the usual radius check. What it refuses to do matters more — an
unrecognised type, an unparseable address or an unplaceable one is dropped
rather than guessed at, and medical calls, drills and unit moves never raise
anything. Because a notification has no id and nothing ever says a call is
over, a phone-sourced call carries `via: "phone"` and expires after three
hours instead of being cleared.

## Known gaps

- **911 calls are unavailable** while PulsePoint blocks automated readers.
- **No phone position reaches the server.** `POST /location/sample` exists
  and the location switch saves a preference, but nothing sends samples: the
  Android app has no location permission or reporter. "Near me" is therefore
  "near my saved places" until that native work ships.
- **Texts are blocked by carriers.** Twilio accepts them and reports
  `undelivered` with error 30034 — the sending number is not registered for
  US A2P 10DLC. Nothing in code can fix that; the Twilio account needs a
  registered campaign or a verified toll-free number.
- **The Android app bundles the web UI inside the APK.** `index.html` and
  `/assets/` are served from the APK, so companion changes reach the phone only
  after an APK rebuild (see `native-runtime/AndroidCompanion~/README.md`).
- **"Use my current location" does not work inside the Android app** — the
  WebView has no geolocation permission handler. Addresses do.
