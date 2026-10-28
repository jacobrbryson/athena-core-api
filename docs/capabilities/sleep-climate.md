---
id: sleep-climate
title: Bedroom temperature and sleep
summary: With Nest and WHOOP linked, I compare your bedroom's temperature on each night with how you slept and recovered, and say which range suits you.
where: Research → Bedroom & sleep; choose the thermostat under Property → Utilities → Thermostats → Use for sleep
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [bedroom temperature, sleep temperature, temperature for sleep, too hot to sleep, too cold to sleep, best temperature, sleep better, bedroom, thermostat at night]
---

## What I can do

For every night WHOOP scores, I work out what your bedroom thermostat read
while you were asleep — averaged over the whole night, not a single reading —
and put the nights side by side by temperature, two degrees at a time. Then I
tell you which range your recovery (or sleep performance, if recovery isn't
scored often enough) was best in, by how much, and over how many nights.

I need fourteen nights before I'll say anything, and I tell you how sure I am.
If you'd like the bedroom at that temperature tonight, ask and I'll offer a
thermostat card for you to approve.

## Where to find it

**Research → Bedroom & sleep** (left navigation). It used to sit on Health and
no longer does. It shows once both Google Nest and WHOOP are linked (⋯ menu →
**Connected apps**); until then it says what's missing.

I use the thermostat with "bed" in its name or room, or your only thermostat.
If that's wrong, go to **Property → Utilities → Thermostats** and tap **Use
for sleep** on the right one.

## When it doesn't work

- **It says it needs more nights.** I only started keeping thermostat history
  when this shipped, so the first fourteen nights after linking are gathering.
- **It asks which thermostat is the bedroom.** Pick one with **Use for sleep**.
- **Nights are missing.** A night only counts if the thermostat reported in
  the hours before bed and WHOOP scored the sleep; naps never count.

## Limits

- **A pattern, not a cause.** Warmer nights might also be nights you went to
  bed late or trained hard. I say what lines up in your own nights; I don't
  claim the temperature did it.
- **One thermostat.** I read the one you chose, which may not be in the room
  you sleep in. Humidity is shown but not compared.
- **I don't change the bedroom on my own.** Setting it is a card you approve,
  every time; Nest schedules aren't something I can write.
- Only what WHOOP and Nest have recorded since I started keeping history.

## Under the hood

- Backend: `src/services/sleepClimate.js` (pairing, bands, sentence; cached 6 h
  in memory), WHOOP paging via `whoop.sleepHistory` in
  `src/services/connectors/whoop.js`, readings from `src/services/nestHistory.js`.
- Routes: `GET /api/v1/dashboard/health/sleep-climate`,
  `PUT /api/v1/projects/property/thermostats/sleep-device` (both in
  `src/controllers/propertyThermostats.js`).
- Prompt: `sleepClimate.promptLine` rides in the WHOOP and Nest context blocks.
- Frontend: `../../../companion/src/components/SleepClimatePanel.tsx` (rendered by
  `ResearchPage.tsx`, see `research.md`),
  "Use for sleep" in `../../../companion/src/components/PropertyThermostats.tsx`.
- Tests: `src/services/sleepClimate.test.js`, `src/services/nestHistory.test.js`.
