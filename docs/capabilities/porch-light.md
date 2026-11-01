---
id: porch-light
title: Front porch lights
summary: I can tell you whether the front porch lights are on, and turn them on or off with your OK each time.
where: Ask me in chat; there's no button for it in the app
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [porch light, porch lights, front light, front lights, front porch, outside light, outside lights, outdoor light, outdoor lights, turn on the light, turn off the light, lights on, lights off]
---

## What I can do

I can check whether the **front porch lights** are on right now, and turn them
on or off. They're on a Wi-Fi wall switch that I reach through the computer at
home, not through the internet.

Ask "is the porch light on?" and I'll read the switch and tell you. That needs
no approval.

Ask me to turn them on or off and I'll put a card in our conversation saying
exactly that ("Turn the front porch lights on"). Nothing changes until you tap
**Approve**, and I only tell you it worked once the switch reports the new
state back.

## Where to find it

Just ask me in the Companion app. There's no porch light button or panel. The
parents' **Test** button for it is on the **Guardians** page, under **Field
Kit** → **Capabilities**, and it's a quick on-then-off check rather than a light
switch.

## When it doesn't work

- **"The porch lights didn't respond."** The computer at home may be off or
  offline, or the switch may have dropped off the Wi-Fi. Try again in a minute;
  the wall switch itself always works by hand.
- **"Control is off."** The home bridge hasn't been set up to send commands yet.
  That's the owner's to turn on.
- **"The kill switch is on."** The Guardians kill switch cuts my control of the
  lights and cameras. A parent can turn it off on the Guardians page, under
  **Field Kit**.
- **"Control porch light is switched off."** That's its own switch under
  **Field Kit** → **Capabilities** on the Guardians page.

## Limits

- **Every change is a card you approve.** I can't change the lights on my own,
  and there's no "don't ask me again" for them.
- **Only the front porch lights.** No other lights or switches in the house.
- **On or off only.** No dimming and no schedules. I can't turn them on at
  sunset or when someone arrives.
- **If someone flips the wall switch, that counts.** I read what the switch says
  now. I keep no history of when the lights were on.
- **Only the household adults who can see the cameras** can use this from chat.
- Blinking them in Morse is only for Guardians missions and the parents' Test.

## Under the hood

- Action: `set_porch_light` in `src/services/actions/registry.js` (owner's
  instruction 2026-11-01; never standing). `availableTo` requires the bridge
  configured, `EUFY_AUTHORIZED_PROFILE_IDS`, a parent actor and a `porch_light`
  capability row, which only family 1 has. Tests:
  `src/services/actions/setPorchLight.test.js`.
- Read: the `porch_light` source in `src/services/needs.js` (household-gated,
  adults only), a live `GET /v1/porch-light`.
- Commands: `setPorchLight` and `porchLightState` in
  `src/services/guardianMissions/house.js`. Everyday use goes through
  `house.permit` as a parent, so mission mode doesn't apply but the kill switch
  and capability switch do. It logs `porch_light_command` to `athena_gm_log` and
  deliberately writes no `athena_gm_test_result`, so it can't move ability scores.
- Home: `../../../eufy-bridge/server.mjs` `/v1/porch-light` needs
  `EUFY_BRIDGE_CONTROL=on`, and that flag also opens pan/tilt and talkback on the
  bridge. `../../../eufy-bridge/tuya/porch.py` (compose profile `porch`) talks to
  the MOES switch over the LAN with TinyTuya; it needs `tuya-secrets.env`
  (`TUYA_DEVICE_ID`, `TUYA_LOCAL_KEY`, `TUYA_IP`, `TUYA_VERSION`). The local key
  comes once from the Tuya IoT platform via `python -m tinytuya wizard`.
- Give the switch a fixed DHCP lease: `TUYA_IP` is read once at startup.
