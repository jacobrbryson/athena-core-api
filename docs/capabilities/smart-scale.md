---
id: smart-scale
title: Smart scale
summary: With your VeSync scale linked, I can see your weigh-ins — weight, body fat and the rest of your body composition — on the Health page and in chat.
where: Companion dashboard → Health → Progress card (Weight and Body Fat tabs)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [weigh, weighed, weight, weigh-in, scale, vesync, etekcity, body fat, bmi, body composition, muscle mass, skeletal muscle, lean mass, visceral fat, bone mass, body water, bmr, metabolic age, dexa, inbody, calibrate]
---

## What I can do

With your VeSync (Etekcity) smart scale linked, I can read your weigh-ins from
the last 90 days. From the scale itself I get weight, body fat and heart rate.

I work out the rest myself from the scale's impedance reading, your height,
age and sex, using published body-composition equations: skeletal muscle,
fat-free (lean) mass, body water and BMR. These are my estimates, marked
**est.** on the page, and they won't match the VeSync app's numbers, which use
Etekcity's own private formula. You don't need the VeSync app for any of it.

If you have a lab result — a DEXA scan, an InBody test, or a height measured at
the doctor's — you can enter it and I'll correct every reading against it.
Corrected numbers are marked **cal.** Body fat and body water shift by the
difference the lab found; muscle and lean mass scale by the ratio. A measured
height replaces the scale's for BMI.

The Health card shows your latest weight and body fat beside your heart
numbers. The Health page adds every measurement from your last weigh-in, plus
eight weeks of weekly averages for weight and body fat. In chat I can answer
"what do I weigh?", "how much have I lost this month?" or "what's my body fat
doing?" from the real readings.

I don't judge which way your weight should go. There are no goals and no
red or green on these numbers, because that's your call.

## Where to find it

Companion dashboard → **Health**. Your weight and body fat sit on the Health
card. On the Health page, the **Progress** card has **Weight** and **Body Fat**
tabs (with body fat, lean mass and your target weight beside the chart).
The page no longer has a Body composition panel, and with it went the
**Calibrate with a lab result** button — there's currently nowhere in the app
to enter or remove a lab reference. References entered before still correct
your readings.

There's no Connect button for the scale. VeSync doesn't offer a sign-in
other apps can use, so the owner links it for you.

## When it doesn't work

- **"Not connected."** The scale hasn't been linked for you. Ask the owner.
- **"Reconnect to refresh."** VeSync refused the saved login, usually because
  the VeSync password changed. The owner needs to link it again.
- **"Health consent required."** Your family hasn't agreed to share health
  data with me yet. **Give consent** on the panel opens that.
- **Body fat or muscle is blank.** The scale only measures body composition
  with bare feet on it. A weigh-in in socks records weight alone.
- **A lab reference didn't change anything.** It's compared with a weigh-in
  within a week of the test. With none that close, I say so on the Calibrate
  form and leave the readings as they were. Step on the scale within a week of
  your next test.
- **Muscle or body water is blank.** Those need the impedance reading, plus
  your height, age and sex in your VeSync profile.
- **A new weigh-in isn't showing.** I keep what I read for up to half an hour,
  and the scale has to sync to the VeSync app first.
- **Something failed.** I'll tell you what VeSync's error actually said.

## Limits

- Read-only. I can't log a weigh-in or change anything in VeSync.
- The last 90 days, up to 100 weigh-ins.
- Only the account holder's weigh-ins. Other family members on the same scale
  aren't read.
- VeSync has no public API. I use the VeSync app's own, which VeSync can change
  without warning, and this can stop working until it's updated.
- Muscle, lean mass, body water and BMR are my estimates from published
  equations for the general population, and can be off for an individual
  until calibrated. I don't estimate bone mass, visceral fat, protein or
  "metabolic age": there's no sound published formula for them from a
  bathroom scale.
- Scale body composition is an estimate from a small electrical current, not
  a medical measurement, and I'm not a doctor.

## Under the hood

- Connector: `../../src/services/connectors/vesync.js` — two-step VeSync
  login (`authByPWDOrOTM` → `loginByAuthorizeCode4Vesync`, with the
  cross-region bizToken retry), scale lookup via `deviceManaged/devices` (ES*
  types), weigh-ins via `/iot/api/fitnessScale/getWeighingDataV4`, the same
  calls as ioBroker.vesync. `normalize()` maps VeSync's several field spellings
  to metric; 30-minute per-profile cache; re-logs in once when the session
  lapses; a refused password marks the credential `needs_reauth`.
- Credential: a `vesync` `api_key` row (allowed in `../../src/services/credentials.js`
  beside `openai`). Access token = session token, refresh token = the VeSync
  password (encrypted; VeSync renews only by logging in again), external
  account id = VeSync accountID, token_type = region. It's not in the OAuth
  registry, so it never appears in Connected apps.
- Linking: `../../scripts/addVesyncLogin.js <athena-email> [--dry-run]` with
  VESYNC_EMAIL / VESYNC_PASSWORD (VESYNC_REGION optional). Prints the fields
  VeSync sent and the newest weigh-in as parsed, so a renamed field shows up
  there rather than as a blank tile.
- Dashboard: the `body` section of `GET /api/v1/dashboard`
  (`../../src/services/dashboard.js`), gated on the link and `health_data`
  consent like WHOOP.
- Chat: registered in `CONNECTORS` in `../../src/services/connectors/context.js`
  (keyword gate, `get_scale_weigh_ins` tool). `HOW_TO_LINK`/`HOW_TO_RELINK`
  replace the "connected-apps settings" advice, since there's no Connect button.
- Frontend: `bodyMetrics()`, `weighInDays()` and `weeklyAverage()` in
  `../../../companion/src/components/Dashboard.tsx`; `WeighIn` type in
  `../../../companion/src/api/dashboard.ts`. Shown in lb with kg in the hint.
- Estimates: `../../src/services/bodyComposition.js` — Sun 2003 (NHANES III)
  fat-free mass and total body water, Janssen 2000 skeletal muscle, Katch-
  McArdle BMR, from `impedance` (whole-body Ω), `heightCm`, `age` and `gender`
  (1 male, 0 female) on each record. The scale's own `bfr` wins over the Sun
  estimate, and fat-free mass follows it. Implausible impedance or outputs
  yield null, not a clamp. `eightImpedanceList` (segmental) is unused.
- Calibration: `body_calibration` table (migration `0068_body_calibration`),
  `../../src/services/bodyCalibration.js`, `../../src/controllers/bodyCalibration.js`,
  `POST /api/v1/dashboard/health/body/calibration`, `DELETE …/calibration/:uuid`.
  Applied at read time in `bodyComposition.enrich()`: newest reference per
  measure, matched to the nearest weigh-in within 7 days; percentages shift,
  masses scale; BMR and BMI re-derived. A missing table reads as no references.
  The weigh-in cache keeps 3 years so an old reference still has a neighbour.
- Calibration UI: `../../../companion/src/components/BodyCalibration.tsx`.
- Tests: `../../src/services/bodyComposition.test.js` (formulas by hand,
  calibration), `../../src/services/connectors/vesync.test.js`, `../../src/services/dashboard.test.js`.
- First real read (2026-10-13, ESF-series 8-electrode scale) sent: weightG,
  bfr, heartRate, heightCm, impedance, eightImpedanceList, timestamp, plus
  sync flags. No muscle/water/bone fields: the VeSync app computes those on
  the phone. Weigh-ins page oldest-first, so `fetchWeighIns` pages to the end.
- `partial` until the paged read is confirmed to reach current weigh-ins.
