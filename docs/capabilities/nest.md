---
id: nest
title: Google Nest thermostats
summary: With Google Nest linked, I see each thermostat's state, warn when one goes offline or the heat isn't keeping up, and on freezing nights.
where: Property → Utilities → Thermostats (or ⋯ menu → Connected apps → Google Nest); the alert itself through Initiative
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [heat not working, heat isn't keeping up, furnace not working, frozen pipes, freeze, nest, thermostat, thermostats, hvac, furnace, heating, heat pump, air conditioning, a/c, house temperature, indoor temperature, humidity, offline, thermostat offline, downstairs thermostat, upstairs thermostat]
---

## What I can do

Once you link Google Nest, I can see the thermostats you chose to share with
me. For each one I know:

- whether it's **online or offline**, and since when
- the **temperature** and **humidity** inside
- its **mode** (heat, cool, both, off or eco) and what it's **set to**
- whether it's **heating or cooling right now**

Ask "is the downstairs thermostat online?" or "what's it set to upstairs?" and
I'll read it live.

With Initiative on, I also tell you when the **heat or cooling isn't keeping
up** (a long run that's barely moved the room, or two days of much slower
runs than usual), and — even in your quiet hours — when it's **forecast to
freeze tonight and the house may not be heating** (a thermostat offline, off,
or already at 50 °F or below).

**I can change one, too — with your OK each time.** Ask me to turn the heat up,
cool the den to 74, switch upstairs to heat-cool, or put a thermostat in eco,
and I'll put a card in our conversation saying exactly what I'll do ("Set the
Den Thermostat: cool to 74°F"). Nothing changes until you tap **Approve**.

**I tell you when a thermostat goes offline.** Google lets me know within
moments of a thermostat losing its connection, and I send you an alert naming
which one and when it dropped. You get one alert per outage. If a second
thermostat drops later, the new alert names both. I say it's offline, not why,
because from where I sit a power cut, a Wi-Fi problem and a fault in the
thermostat all look the same.

**I also catch one Google misses.** Sometimes Google keeps listing a
thermostat as online after it has stopped sending anything, and all it hands
me is exactly 0° and 0% humidity. No room is really freezing and bone-dry at
once, so I treat that as **not reporting**: you get the same alert as for
offline, worded as "not reporting" because Google says otherwise, and I never
quote that 0° as the temperature. As soon as it sends a real reading again,
it's back to normal.

## Where to find it

The **⋯ menu in the top right** → **Connected apps** → **Google Nest** →
**Connect**. Google then shows its own Nest screen, where you pick which home
and which thermostats to share with me. Only what you tick there is visible to
me. The same **Connect Google Nest** button is on the **Thermostats** panel on
the **Property** page's **Utilities** tab.

Once linked, that **Thermostats** panel shows a card for each thermostat: the
temperature inside, humidity, what it's set to, whether it's heating or cooling
now, and a green **Online** or red **Offline since …** tag — or **Not
reporting since …** for one Google lists as online but that's sending nothing,
which shows a dash instead of a temperature. An offline card's temperature is
its last reading before it dropped. **Refresh** at the bottom
reads Google again. The panel itself has no controls — to change a
thermostat, ask me and approve the card.

The offline alert is one of the things I can say first, so it needs
**Initiative** turned on (⋯ menu → **Initiative**). It's listed there as
"A thermostat went offline", and you can mute it there like anything else.
During your quiet hours the alert is held and comes through when they end.

## When it doesn't work

- **"Not connected."** Google Nest hasn't been linked yet, or the link needs
  renewing. **Connect** on its Connected apps row fixes both.
- **A thermostat is missing.** It wasn't ticked on Google's Nest screen.
  Connect again and tick it.
- **I didn't alert you.** Check that Initiative is on and the thermostat alert
  isn't muted. If Google's message didn't reach me, I still notice within
  about an hour, the next time I check your thermostats myself.
- **The readings look old.** For an offline thermostat they are: they're the
  last thing it reported before it dropped, and I say so.

## Limits

- **I keep a history now, from the day this shipped.** Every ten minutes or
  so, and whenever the heat or cooling starts or stops, I note what each
  thermostat read — that's what "it's not keeping up" and the bedroom-vs-sleep
  comparison ([sleep-climate.md](sleep-climate.md)) are measured from. Kept
  120 days. I can't see anything from before it started.
- **"Not keeping up" is a measurement, not a diagnosis.** I can say the heat
  ran 90 minutes and the room moved half a degree; I can't say whether that's
  a filter, a door left open or the furnace. I don't record outdoor
  temperature over time, so a hard cold snap can look like slower heating.
- **The freeze warning needs a home place.** It reads the forecast at your
  home on Community → Watched places; without one I can't tell it's freezing.

- **Every change is a card you approve.** I can't change a thermostat on my
  own, there's no "don't ask me again" for it, and I won't send a change to
  one that's offline or not reporting — Google couldn't deliver it.
- **Mode, temperature and eco only.** Not the fan, schedules, or Nest's
  own settings. Heat can be set from 50 °F to 80 °F and cooling from 62 °F
  to 88 °F; heat-cool keeps at least 3 °F between its two ends.
- Thermostats only for now. Nest cameras, doorbells and smoke alarms aren't
  read, even if they're shared.
- I don't send a separate "it's back online" alert. Ask me and I'll tell you
  it's back and since when.
- Google decides when a thermostat counts as offline, so a very short blip
  might never be reported to me. The one exception I add myself is "not
  reporting" (0° with 0% humidity); any other kind of stuck reading I can't
  tell from a real one.
- Only the person who linked Nest gets the alerts. Anyone else in the family
  who wants them links Nest on their own account.

## Under the hood

- History: `src/services/nestHistory.js` (athena_nest_reading, migration
  0087) — written from `recordEvent` and `sync`, thinned to one row per 10
  minutes plus every hvac/mode/setpoint change, pruned at 120 days by the
  nightly `nestReadingsPrune` step.
- Heating check: `src/services/hvacHealth.js` (runs from history; trigger
  `hvac_struggling`). Freeze: trigger `freeze_risk` in
  `src/services/initiative/triggers.js`, the only `piercesQuiet` trigger
  (owner, 2026-10-20), home place from `weatherAlerts.homePlace`.

- Connector: `src/services/connectors/nest.js` — SDM device list, stored state
  in `athena_nest_device`, `transition()` is the one place connectivity moves,
  `refreshIfStale()` is the hourly backstop, chat tool `get_nest_devices`.
- OAuth descriptor: `nest` in `src/services/connectors/registry.js`. Consent is
  Google's Partner Connections page for the Device Access project
  (`NEST_DEVICE_ACCESS_PROJECT_ID`), reusing the Google OAuth client; callback
  `/integrations/nest/callback`. Only `sdm.service` is requested, no PKCE.
- Push: `src/controllers/nestWebhook.js`, mounted at `POST /webhooks/nest` in
  `src/server.js`. Public entry is the proxy (`../../../proxy_service/src/routes/api/v1/nestWebhook.js`),
  which moves Google's token to `X-Pubsub-Authorization` before its IAM hop. Verifies the Pub/Sub OIDC token against
  `NEST_PUBSUB_AUDIENCE` and `NEST_PUBSUB_SERVICE_ACCOUNT`, stores the event,
  then runs `initiative.evaluateProfile` for any profile whose device just went
  offline, under that profile's own access identity.
- Not reporting: `assess()` in `nest.js` stores 0 °C + 0 % as `OFFLINE` with
  `readings.notReporting` and Google's own flag in `readings.google`;
  `publicRow()` sets `notReporting` and drops the placeholder numbers. Owner's
  call, 2026-10-16, after the Den thermostat showed 32°F/0% while "ONLINE".
- Control: action `set_thermostat` in `src/services/actions/registry.js`
  (owner's instruction 2026-10-16; never standing). `normalize()` resolves the
  thermostat only among the person's own stored rows, refuses offline/not
  reporting, requires a unit with any temperature, and bounds heat 10–26.67 °C
  / cool 16.67–31.11 °C / heat-cool gap 1.66 °C. `execute()` sends eco off →
  mode → setpoint → eco on through `executeCommands()` in `nest.js`, which
  allowlists the five SDM commands and re-reads after. Tests:
  `src/services/actions/setThermostat.test.js`.
- Trigger: `nest_offline` in `src/services/initiative/triggers.js`. Reads only
  stored rows; dedupe key is each offline device plus its `offline_since`.
- Property panel: `GET /projects/property/thermostats` →
  `src/controllers/propertyThermostats.js` (adult-only; no devices without an
  active link; re-reads Google only when rows are 5+ minutes old). UI is
  `../../../companion/src/components/PropertyThermostats.tsx`, loaded only while
  Property → Utilities is on screen; mock in `../../../companion/mock/projects.ts`.
- Migration: `db/migrations/0076_nest_devices.up.sql`.
- Tests: `src/services/connectors/nest.test.js`, `src/controllers/propertyThermostats.test.js`,
  `src/controllers/nestWebhook.test.js`.
- Rows stay after a disconnect but are never read without an active link;
  re-linking re-syncs and drops devices no longer shared.
