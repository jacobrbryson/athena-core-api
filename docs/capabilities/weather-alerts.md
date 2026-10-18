---
id: weather-alerts
title: Weather and weather alerts
summary: I show the week's forecast with a frost read for every night, and send the weather alerts you set — frost, heat, rain, snow, ice, storms or wind.
where: Community → Weather (or Local Weather → Forecast & alerts)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [frost, freeze, hard freeze, first frost, cold snap, how cold, low tonight, overnight low, weather alert, temperature alert, heat alert, cover the plants, cover my plants, tender plants, garden, snow, ice, sleet, freezing rain, thunderstorm, wind alert, gusts, 7 day forecast, seven day forecast, week's forecast, humidity, dew point]
---

## What I can do

On the Community page I show the National Weather Service forecast at home, or
at any of your watched places: right now (with humidity, dew point and wind),
the coldest hour of every night for about the next six nights with how likely
frost is, seven days of highs, lows and chance of rain, and the next two days
every three hours.

The frost read is mine, from the forecast low, the wind and the sky. At 32°F or
below I call it a freeze, at 28°F a hard freeze. Between 33 and 36°F I say frost
is possible, or likely when the night is clear or still — grass and windshields
get colder than the air the forecast measures, so frost forms above freezing.

You can also set weather alerts, and I send them to your phone:

- **Cold / frost** — at or below a temperature you choose (34°F unless you pick another)
- **Heat** — at or above a temperature
- **Rain** — a chance of rain at or above a percentage
- **Snow**, **Ice** (sleet or freezing rain), **Thunderstorms** — any in the forecast
- **Wind** — wind or gusts at or above a speed

Each alert is for one watched place (home unless you choose another), warns
you a set time ahead (a day unless you choose 6 hours to 3 days), and can carry
a note I include with it, like "cover the tomatoes". I tell you once per night
for cold and once per day for everything else. If the forecast changes after
that, I don't send a correction. If I spot something in the middle of the night,
I wait until 7 AM, unless it's less than six hours away. Waiting never drops an
alert, it only delays it.

## Where to find it

Open **Community** and scroll to **Weather** under The detail, or use **Forecast
& alerts** on the Local Weather card at the top. If you watch more than one
place, tabs at the top of the panel switch between them. Under **Weather
alerts**, **Add a frost alert (34°F)** sets the common one in one tap, and **+
New weather alert** opens the full form (what to watch for, the threshold,
where, how far ahead and an optional note). Each alert has **Edit**, **Pause**
and **Remove**, and shows the next time the forecast meets it. **Recently sent**
lists what I've sent in the last two weeks and whether it reached your phone.

## When it doesn't work

- **"Couldn't check" on an alert:** the weather service didn't answer, or the
  alert's place was removed or paused. I try again every half hour. A failed
  check is never treated as "nothing to report".
- **An alert I sent never reached your phone:** it still appears in the app,
  and Recently sent says it didn't reach the phone. Check **Reach me outside the
  app** and the phone's notification permission for Athena.
- **No weather at all:** I need at least one watched place with a location, and
  the forecast covers the United States only.

## Limits

The forecast comes from the National Weather Service and covers about six days
by the hour, so an alert can't fire for something further off. Everything I
show and send is a forecast, not a measurement. I don't have a thermometer at
your house. Frost depends on low spots, shelter and ground cover, and I can't
see any of those. I can't create or change an alert for you from a conversation.
You set them on the page. Up to twenty alerts. I don't send an all-clear when a
forecast warms back up. These alerts are separate from the severe-weather
warnings I already pass on for your watched places (see nearby incidents), which
come from the National Weather Service's own warnings rather than your
thresholds.

## Under the hood

**Never sent to a model.**

- Forecast: `../../src/services/weather.js` — `outlook()` (48 h + 7-day from
  the NWS `forecast` URL + `nightsOf`/`frostRisk`), `hourlyRows()` for the
  rules, `local()` reads wall-clock from the NWS offset (no tz table).
- Rules: `../../src/services/weatherAlerts.js` — `checkDue` (claim =
  INSERT IGNORE on `athena_weather_alert_fire (alert_id, occurrence)`; cold is
  keyed by the night's evening date, others by local date), night hold
  22:00–07:00 unless within 6 h (held = nothing written), nudge
  `trigger_id = weather_alert` + `push.deliverNudge`. Not Initiative: the
  person's own request, like place reminders.
- Job: `../../src/jobs/incidents.js` → `weatherAlertPass()` every tick; each
  rule re-reads at most every 30 min (`last_checked_at`). `--dry-run` prints
  the messages.
- Routes: `GET /api/v1/dashboard/weather/outlook?place=`,
  `GET|POST /api/v1/dashboard/weather/alerts`,
  `PATCH|DELETE /api/v1/dashboard/weather/alerts/:uuid`
  (`../../src/controllers/weatherAlerts.js`).
- Schema: `../../db/migrations/0080_weather_alerts.up.sql` — apply before
  deploy, or the panel's alert list and the job pass fail (the outlook still works).
- Chat: `weatherAlerts.promptBlock` in `../../src/controllers/gemini.js`.
- Frontend: `../../../companion/src/components/WeatherPanel.tsx`, mounted as
  `#community-weather` in `Dashboard.tsx`; styles `wx-*` in `community.css`.
- Tests: `../../src/services/weatherAlerts.test.js`, `../../src/services/weather.test.js`.
