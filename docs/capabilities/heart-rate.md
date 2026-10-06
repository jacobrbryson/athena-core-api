---
id: heart-rate
title: Live heart rate and exercise limits
summary: In the Android app I can read your WHOOP or a heart-rate strap live, say out loud when you cross a ride or run limit, and keep minute summaries.
where: the ⋯ menu (top right) → Phone & car → Heart rate (Android app only)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [heart rate, heartrate, live heart rate, pulse, bpm, heart rate limit, heart rate zone, heart rate broadcast, whoop broadcast, chest strap, heart rate alert, over 165, too high on my ride, heart rate on my run]
---

## What I can do

In the Android app I can connect to your WHOOP (with **Heart Rate Broadcast**
turned on) or any standard Bluetooth heart-rate strap and read your heart rate
live.

**Exercise limits.** For a ride and for a run you can set an upper limit, a
lower limit, or both — say "over 165" and "under 100". Start a ride or run in
the app, and the moment you cross a limit I say it out loud ("Heart rate's over
165"), into your earbuds if they're in, turning music down while I talk. It all
happens on the phone, so it works on a trail with no signal. You get one alert
each time you cross; I only warn again after you've been back inside by a few
beats for about ten seconds, so hovering right at the line doesn't set me off
over and over. If the band drops out during a ride or run I tell you ("I've
lost your heart rate") and again when it's back, because while it's gone
nothing is being watched. The lower limit only starts counting once you've
been above it, so a slow warm-up isn't an alert.

The alerts are in my own voice when they were saved on the phone while it had
signal (saving your limits does that). If one wasn't, the phone's built-in
voice says it instead — still offline.

**Sharing with me.** If you switch on sharing, the phone sends me a summary for
each minute — low, average and high — and I can look at them when you ask, or
when your heart rate is relevant to something else we're talking about. I
compare them with your usual numbers and your WHOOP resting heart rate if WHOOP
is connected. I don't watch it in the background or bring it up on my own.

## Where to find it

In the Android app: the **⋯ menu** → **Phone & car** → **Heart rate**.

1. On your WHOOP: in the WHOOP app, turn on **Heart Rate Broadcast**.
2. Tap **Connect my heart-rate band**. Android asks for **Nearby devices**
   (Bluetooth) permission, and on newer phones for notifications so the
   "reading your band" sign can show. If more than one band answers, choose yours.
3. Enter limits under **Exercise limits** and tap **Save limits** — do this with
   signal, so the alerts are saved in my voice.
4. Tap **Start ride** or **Start run** when you set off; **End ride** (here or on
   the notification) when you're done.
5. Optional: tick **Let Athena keep one-minute summaries** so I can check them.

## When it doesn't work

- **"I can't find your band" / "didn't accept the connection".** A band usually
  allows one connection at a time. If Peloton or another app is
  connected to it, disconnect it there. Check Heart Rate Broadcast is still on
  in the WHOOP app and the band is close to the phone. I keep retrying while
  it's switched on.
- **No alert on my ride.** Limits only apply during a ride or run you started in
  the app, and only for the bounds you set for that activity. Check the
  notification shows the limits.
- **Alerts in a robotic voice.** They weren't saved in my voice yet — save your
  limits again while you have signal.
- **I can't see your heart rate when you ask.** Sharing has to be on, and the
  phone has to have been connected to the band recently. Minutes recorded
  without signal are sent when the phone gets back online (up to a day later).

## Limits

- Android app only — not the website, not iPhone.
- Not a medical device, and I don't diagnose anything from it.
- I don't raise heart rate on my own — no alerts from me about spikes in a
  meeting or at night. The only spoken alerts are the limits you set, during a
  ride or run you started.
- I never keep individual readings, only minute summaries, and only for 30 days
  (you can shorten it). Turning sharing off deletes them.
- While I hold the band, Peloton or another app can't connect to it. Stop it in the
  app or from the notification to hand it back.
- After a phone restart it waits for you to open the app before reconnecting.

## Under the hood

- Native: `../../../native-runtime/AndroidCompanion~/AthenaDashboard.androidlib/java/com/orcwood/athena/dashboard/HeartRateService.java`
  — connectedDevice foreground service; BLE scan filtered to 0x180D, subscribes to 0x2A37
  (uint8/uint16 parse in `parseBpm`); `enabled` pref + `resumeIfEnabled()` in
  DashboardActivity.onResume. Limits: `Limit.check` — outside for 5 s = one crossing,
  re-arms after 10 s back inside by 3 bpm; lower bound starts disarmed. Lost-band alert
  after 30 s with no reading during a session (PARTIAL_WAKE_LOCK held only during a session).
  Minute summaries queue in the app's no-backup files dir as athena-heart-queue.json (24 h max) and
  POST `/api/v1/heart/minutes` with the device token every minute, only while `share` is on;
  a 403 turns `share` off and clears the queue.
- Voice: `AthenaVoice.java` — clips fetched via `HandsFreeClient.voice()` (`POST /speech`,
  WebView cookie) when limits are saved, cached in the no-backup files dir under athena-voice;
  missing clip → Android `TextToSpeech`. Every say() is queued, none dropped.
  `HandsFreeService.speak()` shares `AthenaVoice.play()`.
- Bridge: `heartRateStatus/Start/Stop/Choose/Forget/Share/Session/Limits` in `DashboardActivity`.
- Panel: `../../../companion/src/components/HeartRate.tsx`, `../../../companion/src/native/heartRate.ts`,
  `heartApi` in `../../../companion/src/api/companion.ts`.
- API: `src/routes/heartRate.js`, `src/controllers/heartRate.js` (every route `requireAdultActor`;
  `PUT /pref` session-only, `POST /minutes` device-only), `src/services/heartRate.js`.
- Chat: `heartRate.buildContext` in `src/controllers/gemini.js`, keyword-gated, adults with
  sharing on only; adds WHOOP resting HR via `whoop.listRecovery` when linked.
- Schema: `db/migrations/0048_heart_rate.up.sql` (`athena_heart_pref`, `athena_heart_minute`).
  Retention default 30 days (7–30), purged on every upload; pref off deletes all rows.
- Deliberately no initiative trigger: the owner (2026-09-29) chose "a dumb system she can
  check". A "notable for this context" trigger was designed and not built.
- Tests: `src/services/heartRate.test.js`.
