# Security stances

**Status: design only (2026-11-14). Nothing here is built.** Open questions are
marked **OPEN** and collected at the end.

A household-wide setting, picked under Companion → Property → Security, that
tells every part of Athena how watchful to be right now. Four stances, from
calm to the most intense:

| Stance | When | One-line intent |
|---|---|---|
| **Home** | Family home, normal day | Today's behaviour. |
| **Elevated** | The owner is away, others may be home | Watch closer, tell the owner about anything unusual. |
| **Locked Up** | Everyone is away | Tell the owner about **every** change. |
| **LOCK DOWN** | An unknown emergency: cyber, civil unrest, break-in, no one knows | Assume nothing outside the house can be trusted or reached, and keep working anyway. |

The design principle for LOCK DOWN comes straight from the owner's framing:
the threat is unknown, so the stance does not defend against one threat. It
makes the house **self-sufficient**: local processing, local evidence, local
presence, a way to account for every person, with outside links used only
when they are available and trusted.

## What a stance is (and is not)

- **One row per household** with the current stance, who set it, when, why,
  and an optional planned end. Every change is appended to a history table and
  to `athena_access_audit`.
- **A bundle of settings**, not a new execution path. Each physical or
  network effect of a stance (router rule, recording mode, model policy,
  thermostat hold) is an **action-layer proposal** (`services/actions/`,
  protected) that goes through propose → confirm → audit like any other.
  Entering a stance shows one approval card listing the actions it will take.
  Athena has no way to switch the house by herself.
- **Visible to everyone it affects.** Every family member's phone shows the
  current stance and that presence is being used. Nothing happens silently.

### Stance matrix

| | Home | Elevated | Locked Up | LOCK DOWN |
|---|---|---|---|---|
| Camera sightings alert on | strangers at the door | every person or vehicle | every motion event | record everything |
| Notifications | as today | unknown people, doors, garage | **every change**: cameras, thermostat, lights, devices offline, network | every change; quiet hours **OPEN** |
| Garage/door sweep | nightly (Guardian Engine) | nightly + on departure | on arming, then periodic rechecks | continuous while active |
| Anomaly scanning | baseline | moderate | tight | anything off-baseline |
| Model routing | smart | smart | smart | **local only** |
| Location upload | normal | normal | normal | **to the house only**, never the cloud |
| Network | normal | normal | normal | **internet cut except Tailscale** |
| Evidence | on request (as today) | on request + sightings | sightings + key clips | everything, local + encrypted off-site copy |
| Lowering it needs | anyone in the household | the owner | the owner | the owner + a second check |

## Changing stance

- **Manual** from the Security tab or chat ("we're all leaving, lock it up").
- **Suggested** by presence or an anomaly: "Every phone just left home. Switch
  to Locked Up?" A suggestion is a proposal card, never a switch.
- **Raising and lowering are different.** The owner may grant a standing
  approval for specific *raises* (e.g. Home → Locked Up when the last phone
  leaves). *Lowering* never has a standing approval: someone holding a stolen
  phone must not be able to disarm the house. Lowering out of LOCK DOWN also
  needs a second check (**OPEN**: PIN, second adult, or a fresh sign-in).
- Learned behaviour (anomaly scores, appraisals) may *propose* a raise. It never
  raises, lowers, or holds a stance by itself.

## Notifications: "every change"

The owner's no-budget rule (2026-09-19) already says nothing is dropped. Locked
Up and LOCK DOWN make that explicit at the source: every state change from a
connected, consented device becomes its own nudge. Each one has its own collapse
key, and nothing is filtered to "most important only".

Delivery follows the **Guardian Engine's footing** (`athena_nudge` +
`push.deliverNudge`, the configuring adult's own alert), **not** Initiative.
`services/initiative/` is protected and needs no change for this. Quiet hours
**hold** pushes as they do everywhere. Whether LOCK DOWN (or Locked Up) should
push *through* quiet hours, as `freeze_risk` does, is the owner's decision
(**OPEN**). If yes, the owner must explicitly authorize it, and it is recorded
in AGENTS.md like the `freeze_risk` exception.

## Presence layer

Answers "who is home, and where is everyone?". Used to suggest stance changes,
to catch mismatches, and to account for people in LOCK DOWN.

**Scope (owner, 2026-11-14): everyone in the household is tracked. All devices
are Android.**

| Signal | Source | Notes |
|---|---|---|
| Wi-Fi association | Router client list | The most reliable signal; needs nothing on the phone. Also gives a **device inventory**: an unknown device joining while everyone is away is a top-tier anomaly. Needs router access (**OPEN**: router make/model). |
| Phone location | Companion APK geofences + silent-FCM fix (reuses place reminders and travel distance) | Android keeps revoking "Allow all the time"; the app must watch that permission and report losing it, never go quiet (see the place-reminders lesson from 10-24). |
| Watches | WHOOP over BLE (exists), plus any watch on home Wi-Fi | A second presence signal. Using **heart rate** for anomalies would reverse the owner's 09-29 "plain store, no trigger" decision (**OPEN**). |
| Mismatches | Derived | e.g. a phone away while its owner's watch joins home Wi-Fi, or every phone away but motion in the garage. Plain code, no model. |

Rules:

- Presence feeds stances and anomalies only. It is **not** a browsable
  location history.
- Data collected because of a higher stance expires when the stance is lowered.
- Children's presence data never enters `athena_mind` (existing dreaming rule).
- Every person's phone shows that they are included.

## Anomaly scanning that scales with the stance

Athena keeps a **household baseline**: usual comings and goings by person and
hour, normal camera activity by hour, usual thermostat changes, the set of
devices normally on the network, normal power draw (once there is a UPS or
solar).

| | Home | Elevated | Locked Up | LOCK DOWN |
|---|---|---|---|---|
| Checks run | on events + nightly | + on each arrival or departure | + every 15–30 min | continuous |
| How unusual before alerting | large | moderate | small | any deviation |
| Sources | cameras, Nest | + presence | + device inventory, offline devices, power | + network traffic patterns |

- **No frequent schedulers** (owner rule). Raising the stance books a
  time-limited chain of Cloud Tasks, and lowering it cancels them. Home mode
  costs what it costs today.
- **Cheap checks are code** (wrong device, wrong place, motion with nobody
  home), so they still work when the only model is a small local one.
- Model reads (e.g. "is this camera frame normal for 3 AM?") use the heavier
  model in higher stances, which in LOCK DOWN means the local one.
- An anomaly **proposes** a stance raise. It never switches.

## LOCK DOWN in detail

### 1. Local Athena on BT-ONE
Local-only *models* are not enough if Cloud Run, GCP or the internet are gone
or compromised. LOCK DOWN needs a small **local Athena** on BT-ONE (already the
Eufy bridge host and Ollama box) that takes over: chat over the home LAN,
cameras through the bridge, presence from the router, alerts to phones on the
LAN or tailnet. The cloud Athena becomes a fallback. Foundation: the model
contingency work (2026-11-14: Ollama gate, smart routing). **This is the
largest build in the feature.**

### 2. Network
A router allowlist lets only Tailscale out (control plane + DERP relays + direct
UDP), so the owner can still reach home while any internet exists. With no
internet at all, everything keeps working on the LAN. Known side effects:

- Nest control stops (SDM is cloud-only).
- Google Home and the porch light's cloud stop working. Local Tuya control
  through the bridge sidecar still works.
- Pushes through FCM stop. Phones hear from local Athena only over LAN or
  tailnet.
- Family Wi-Fi loses the internet. Phones keep cellular, and 911 is
  unaffected.

### 3. Evidence
Everything records to encrypted local disk on BT-ONE. When an outside link is
up *and trusted*, an encrypted copy goes to `athena-security-media`, so a stolen
box does not take the evidence with it. If the link is not trusted, uploads
queue until the owner approves.

### 4. Location
Phones keep tracking but report **to the house only** (LAN or tailnet), never
to the cloud. The last known location of each person is cached locally, so
Athena can say where everyone was last seen even if everything goes dark.

### 5. Family check-in
Entering LOCK DOWN puts a full-screen **"I'm safe / I need help"** prompt on
every phone. Athena tracks who has answered and escalates anyone who hasn't
(repeat prompt → owner alert with last known location). In an unknown emergency
this is how the owner learns whether everyone is OK.

### 6. Power
See below. On battery, local Athena drops to a smaller model and sheds load.

### 7. Getting out
Lowering needs the owner + a second check. A **recovery script on BT-ONE**
restores the router rule if LOCK DOWN locks Athena out of the router. There is
never a timer that unlocks the house by itself.

## Power (owner: no UPS yet; wants UPS, maybe solar)

- **Two UPS tiers.** Network gear (modem, router, HomeBase, PoE switch,
  ~30–60 W) on a mid-size unit for hours of runtime. This matters most. BT-ONE
  (a GPU box, 300–500 W under inference) on its own larger unit, good for
  minutes. Pure sine wave, USB data.
- **Monitoring:** USB into BT-ONE, read through NUT (Network UPS Tools), local
  only. On battery = anomaly + proposed raise. Runtime left is shown on the
  Security tab and in every LOCK DOWN alert. Clean BT-ONE shutdown before the
  battery is empty, with the network UPS kept up longest.
- **Solar/battery:** the system must have a **local API**, or Athena goes blind
  exactly when it matters. Victron (Modbus/MQTT) fits best, Enphase IQ Gateway
  works, Powerwall's local API is limited, and portable stations are mostly
  cloud-only. With one, Athena shows solar input, charge and hours of autonomy,
  and in LOCK DOWN sheds load (thermostat hold, fewer recording cameras,
  smaller model).

## Protected areas this touches

| Area | Why | Needs |
|---|---|---|
| `services/actions/` | Each stance effect is a new action (router rule, recording mode, model policy, thermostat hold, check-in prompt) | Owner's explicit OK to add the actions. None of them standing except owner-granted raises. |
| `services/initiative/` | Avoided: alerts use the Guardian Engine nudge path | Nothing, unless the owner wants stance alerts to pierce quiet hours |
| Provider adapters / tailnet proxy | Local Athena and router control are new token-consuming or tailnet paths | Guarded adapters, owner's OK |
| Docker/deployment | Local Athena is a new deployable on BT-ONE | Owner's OK; non-root image, root-owned code |

## Build phases (value first)

1. **Stances + every-change notifications.** The household stance row, history,
   Security tab picker, the per-stance notification and sightings settings.
   Uses existing sources only.
2. **Presence.** Router Wi-Fi presence + device inventory, APK presence and
   permission watch, family-visible indicator, stance suggestions.
3. **Anomaly scanning.** Baseline, code checks, per-stance Cloud Task chains,
   proposed raises.
4. **Power.** UPS via NUT on BT-ONE, then solar if bought.
5. **LOCK DOWN.** Router allowlist + recovery script, local evidence +
   encrypted off-site, house-only location, family check-in, then local Athena
   on BT-ONE.

Each phase ships with its capability file and LEDGER line
(`docs/capabilities/`).

## Open questions

- **Router make/model.** The owner is getting this; it blocks Wi-Fi presence and
  the network cutoff.
- **Quiet hours:** should Locked Up and/or LOCK DOWN push through them?
- **Second check** for lowering out of LOCK DOWN: PIN, second adult, or fresh sign-in?
- **Elevated:** exactly who is away (owner only, or any adult) and does it
  change anything the family at home sees?
- **Heart rate** as an anomaly source (reverses the 09-29 decision)?
- **UPS/solar** choices, once bought.
