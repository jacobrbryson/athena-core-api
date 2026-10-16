---
id: nest
title: Google Nest thermostats
summary: With Google Nest linked, I can see whether each thermostat is online, the temperature inside and what it's set to — and tell you when one goes offline.
where: the ⋯ menu (top right) → Connected apps → Google Nest; the alert itself through Initiative
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [nest, thermostat, thermostats, hvac, furnace, heating, heat pump, air conditioning, a/c, house temperature, indoor temperature, humidity, offline, thermostat offline, downstairs thermostat, upstairs thermostat]
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

**I tell you when a thermostat goes offline.** Google lets me know within
moments of a thermostat losing its connection, and I send you an alert naming
which one and when it dropped. You get one alert per outage. If a second
thermostat drops later, the new alert names both. I say it's offline, not why,
because from where I sit a power cut, a Wi-Fi problem and a fault in the
thermostat all look the same.

## Where to find it

The **⋯ menu in the top right** → **Connected apps** → **Google Nest** →
**Connect**. Google then shows its own Nest screen, where you pick which home
and which thermostats to share with me. Only what you tick there is visible to
me.

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

- **I can only look.** I can't change the temperature, the mode or anything
  else on a thermostat.
- Thermostats only for now. Nest cameras, doorbells and smoke alarms aren't
  read, even if they're shared.
- I don't send a separate "it's back online" alert. Ask me and I'll tell you
  it's back and since when.
- Google decides when a thermostat counts as offline, so a very short blip
  might never be reported to me.
- Only the person who linked Nest gets the alerts. Anyone else in the family
  who wants them links Nest on their own account.

## Under the hood

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
- Trigger: `nest_offline` in `src/services/initiative/triggers.js`. Reads only
  stored rows; dedupe key is each offline device plus its `offline_since`.
- Migration: `db/migrations/0076_nest_devices.up.sql`.
- Tests: `src/services/connectors/nest.test.js`,
  `src/controllers/nestWebhook.test.js`.
- Rows stay after a disconnect but are never read without an active link;
  re-linking re-syncs and drops devices no longer shared.
