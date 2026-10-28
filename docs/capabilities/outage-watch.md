---
id: outage-watch
title: Outage watch
summary: When several things at home go quiet together I tell you, look for a published cause, and say when they are back; I also report a silent camera bridge.
where: Athena's notifications (in-app and phone); nothing to switch on
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [power outage, power out, power cut, outage, lights out, everything offline, went offline, duke energy, why is everything off, camera bridge, bridge down, cameras offline, cameras not working]
---

## What I can do

If two or more things at home go offline close together, such as two thermostats, or a thermostat and the camera bridge, I treat it as a suspected outage. A few minutes later I check again, because when the home internet is out nothing can tell me so and I only notice by what has gone quiet. Then I send one calm message: what went offline and about when, what I found about a cause, and what I couldn't check. I look for a cause in three places: 911 calls near home in the last 30 minutes, active National Weather Service alerts for your watched places, and a web search for utility, county and local news about an outage near your town. When the things come back I send one short follow-up with the time and, if I found it, the cause.

I also watch the camera bridge on its own. If it hasn't answered for 45 minutes and no wider outage explains it, I say so, and I say separately if it's running but needs its Eufy sign-in again. I tell you when it's back.

I say plainly when the cause is unknown or a check failed. I won't guess at a cause.

## Where to find it

There's nothing to turn on. The messages come as my notifications to the household's authorized adults, and they appear in our conversation. They rely on the Nest link, and on the camera bridge for the camera part.

## When it doesn't work

- **I said nothing during an outage:** if the home internet and power were both out, the Nest alerts and my checks may have been delayed until things returned. I also only check on the hour if no event started a check.
- **"My search didn't work":** the web search failed or timed out. The message says so, and I'm not claiming nothing is wrong.
- **No camera bridge message though the cameras are dead:** I check about hourly, so allow for up to an hour plus the 45 minutes.

## Limits

- A power cut and a home internet outage look identical to me. I can't tell which it is from the devices alone.
- I can't read Duke Energy's outage map. It isn't offered as a data feed I'm allowed to use, and it blocks automated readers, which I won't work around. I also don't read X/Twitter, because it has no free access. My search of news and utility pages is the substitute.
- 911 calls come only from the PulsePoint notifications on your phone, and only the ones near your watched places. No calls is not proof that nothing happened.
- The "widespread" judgement only comes from a published source saying so. Otherwise I say I can't tell.
- It never restarts or changes anything at home.

## Under the hood

- Service: `../../src/services/outage/` — `classify.js` (pure: the cluster rule and all wording), `evidence.js` (911 rows, NWS, grounded search plus a structured read of it), `store.js`, `index.js` (`run`, `noteNestEvent`, `backstopDue`). Nudges use `trigger_id: 'outage'` and `push.deliverNudge`, in the Guardian Engine's footing, not Initiative: no cap, cooldown, spacing or shared collapse key. Recipients are `EUFY_AUTHORIZED_PROFILE_IDS`. Quiet hours do not hold these (a decision for the owner to confirm).
- Trigger: the Nest webhook (`../../src/controllers/nestWebhook.js`) books one Cloud Task through `guardianEngine/dispatch.wakeAt` (name `outage`, five-minute buckets, about 3 minutes after the first offline event; one when a device returns during an open episode). The task calls `POST /internal/guardian/dispatch` with reason `outage:*`, which runs `outage.run` after the Guardian pass (`../../src/controllers/guardian.js`). The hourly `athena-incidents` job (`outagePass` in `../../src/jobs/incidents.js`) asks for a run when none happened in an hour (15 minutes during an open episode). Both need the Guardian dispatch env (`GUARDIAN_DISPATCH_URL`, `GUARDIAN_DISPATCH_AUDIENCE`, service accounts); without it nothing runs.
- Tables (migration `../../db/migrations/0101_outage_watch.up.sql`): `athena_outage_episode`, `athena_outage_assessment` (every pass, including `quiet` and `check_failed`), `athena_camera_bridge_health`.
- `eufyBridge.health()` is the bridge probe. `nest.recordEvent` now also returns `wentOnline`.
- Duke Energy: no public API or developer terms found (2026-10-28); `duke-energy.com` returns 403 to automated fetches. Unbuilt sanctioned option: read Duke's own outage texts/emails through the Gmail connector, or generalise `PulsePointListener`'s package filter (Android change, needs an APK rebuild).
- Bridge side: `../../../eufy-bridge/server.mjs` watchdog and bounded login, `compose.yaml` healthcheck, `diagnose.ps1`.
- Tests: `../../src/services/outage/outage.test.js` (mocked store/search/push; no real outage has been observed).
