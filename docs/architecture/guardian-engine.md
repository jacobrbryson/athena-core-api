# The Guardian Engine

How Athena checks the house on a schedule or when the weather turns, tells the
right adults when something is wrong, and keeps hold of the problem until it is
verified fixed — without ever letting a model decide whether, when or whom.

Built 2026-10-23 on the owner's specification. First protocols: the 10:00 PM
**nightly sweep** (garage doors, and the patio umbrella when the weather
warrants) and the **storm umbrella watch** (the same umbrella check, started
by the weather itself, at any hour).

## Naming

The household Guardians are people (the `guardian_*` tables, `guardianAuth`,
Guardian access grants). To keep the two apart in code, this engine lives in
`src/services/guardianEngine/` and its tables are `athena_guard_*`. The person
reads "Guardian" in the app; nothing here touches Guardian identity or access.

## What it reuses

| Need | Existing piece | How it is used |
|---|---|---|
| Fresh camera frames | `eufy-bridge` `GET /v1/devices/:sn/snapshot?kind=fresh` | Only fresh, non-retained frames count (the bridge answers 409 for a retained still). Stored thumbnails are never evidence. The bridge client moved from `controllers/propertySecurity.js` to `services/eufyBridge.js` so both use one fixed-destination client. |
| Camera status | bridge `GET /v1/status` | A camera missing from the roster, or a bridge that is not `ready`, is **offline** — never "fine". |
| Vision | `llm.generateJson({ task: "vision" })`, as `sightings.identify` does | Run inside `access.context` as the protocol's configuring adult, so the live grant check applies exactly as for a person. |
| Evidence storage | `securityMedia.save` → private bucket + `athena_security_media` | Kept only for unsafe or unverifiable results; served back through the existing audited `/property/security/media/:id`. Safe frames are discarded. |
| Weather | `weather.hourlyRows` (NWS hourly, wind incl. gusts) and `pulsepoint/nws.alertsForPlace` (NWS active alerts) | No forecast is "unknown", never "calm". |
| Home location | `weatherAlerts.homePlace(profileId)` | The configuring adult's home watched place. |
| Notifications | `athena_nudge` row + `push.deliverNudge` (FCM, web push, SMS devices) | Same path as weather alerts: the person's own configured alert, not Initiative. In-app nudge is always written, so a push failure still leaves the alert in the app. |
| Exact-time wake-ups | Cloud Tasks, as `reminderWakeups.js` books them | One task per minute-name; an existing name is success. |
| Backstop schedule | `src/jobs/incidents.js` (the `athena-incidents` Cloud Run Job) | Plans due runs, detects missed ones, dispatches observation to the service. |
| Household authorization | `EUFY_AUTHORIZED_PROFILE_IDS` + `requireAdultActor` (Companion sign-in only) | The same allowlist that gates camera access gates every Guardian route, and limits recipients. |
| Audit | `athena_access_audit` | Config changes, manual runs, acknowledgements, dismissals and every policy refusal. Plus the engine's own `athena_guard_event` history. |

Not reused, deliberately:

- **Initiative** (`services/initiative/`, protected). Guardian alerts are
  protocols an authorized adult switched on and addressed — the same footing
  as `weatherAlerts`. They do not need Initiative's opt-in and do not add a
  trigger to it. Initiative's rules about loss still apply in spirit: nothing
  here drops a true observation, quiet hours **hold**, and dedupe is
  per-occurrence (one open incident per condition).
- **The action layer** (`services/actions/`, protected). The engine executes
  nothing physical. Its own steps (capture, analyse, record, notify) are
  internal and pass the autonomy policy below; anything physical — closing a
  garage door — is Level 3 and the engine refuses it. A future "close the
  garage" must be an action-layer proposal a person approves.

## The split

```
  PLAN (anywhere: job or service)        DB + weather only, deterministic
    scheduled runs, weather triggers,    idempotent: UNIQUE(household, protocol, occurrence)
    incident rechecks, missed-run check
            │
            ▼  dispatch (HTTP with Google ID token, or Cloud Task at the exact minute)
  OBSERVE (core service only: tailnet)   lease-claimed, exactly-once per attempt
    fresh frame → vision → fuse with sensors → classify → evidence
            │
            ▼
  EVALUATE (deterministic)               confidence threshold, freshness, conflicts
    safe | attention_required | unknown
            │
            ▼
  INCIDENT + NOTIFY (policy-checked)     one open incident per (check, subject)
```

Only the core Cloud Run service has the Tailscale path to the bridge, so only
it can observe. The `athena-incidents` job can't, so it plans and then asks the
service to observe. If the service never answers, the job's planner notices
the run is overdue and reports **"I couldn't verify"** — a missed sweep is
never silent.

## Protocol definition

`protocols.js` registers each protocol as code, versioned:

```js
{
  id: "nightly_sweep", version: 1,
  label, describe,
  triggers: [{ kind: "schedule", at: "22:00", timeZone: "America/New_York" }],
  checks: ["garage_door", "patio_umbrella"],          // checks.js
  requires: ["camera"],                               // integrations
  defaults: { ...config },                            // per-household overrides in athena_guard_protocol.config
}
```

Checks (`checks.js`) are the reusable part — a protocol is a schedule plus a
list of checks. Each check declares what it observes (`camera` + region), its
vocabulary (`closed | open | unknown`, `down | up | unknown`), which value is
unsafe, its severity, when it applies (`patio_umbrella` only under weather
risk), its recheck interval and its notification wording. Future protocols
(exterior doors, leaks, smoke/CO, arrivals) add a check and, where a new
sensor exists, an observer.

## States

Run: `scheduled → observing → evaluating → safe | attention_required | unknown
→ notified`, plus `failed`, `expired`, `suppressed`. Incident: `open → notified
→ acknowledged → resolved`, or `dismissed` / `expired`. `transition()` holds
the only table of legal moves; an illegal move throws. Acknowledged is not
resolved: only fresh evidence of the safe state (or an adult's explicit
dismissal with a reason) closes an incident.

`suppressed` means the protocol or check did not apply (disabled, or no
weather risk for the umbrella) and is recorded as such. It never means an
observation was thrown away.

## Truth rules

1. **Fresh or nothing.** A frame counts only if the bridge captured it for
   this request and it is younger than `maxEvidenceAgeSec` (default 120 s)
   when evaluated. A stale frame, a stored thumbnail, or an old observation is
   never evidence of current safety.
2. **Unavailable is unknown.** Camera offline, bridge down, capture refused,
   vision outage, not visible: the result is `unknown` with the reason, never
   `closed`/`down`.
3. **Confidence gates verdicts.** Below `minConfidence` (default 0.75) the
   model's verdict becomes `unknown`. `partially_open` is `open`.
4. **Sensors corroborate; conflicts are unknown.** A fresh sensor reading that
   agrees raises confidence; one that disagrees makes the result `unknown`
   ("camera and sensor disagree"). Today no garage sensor is connected — the
   observer slot exists and is exercised in tests.
5. **Unknown retries, then reports.** Up to `retries` fresh captures, then
   the adults are told the condition could not be verified.

## Autonomy policy (`policy.js`)

Deterministic. Actions are code constants; nothing a model returns can name
one. Five levels: 0 observe only, 1 silent internal, 2 act and notify, 3 ask
first, 4 prohibited without specialised authorization.

Each action is scored on cost, physical risk, privacy, reversibility, social
consequence, confidence and scope, then **hard rules override the score**:
any physical actuation ⇒ ≥ 3; purchases ⇒ ≥ 3; messages beyond approved
household recipients ⇒ ≥ 3; changes to security permissions ⇒ 4; imagery
leaving the household ⇒ 4. The engine executes Level ≤ 2 only. Per-protocol
configuration may make an action *more* restrictive (e.g. notify → observe
only); it can never lower a level. Every decision is written to
`athena_guard_event`; refusals also go to `athena_access_audit`.

Standing permissions (Level 1–2): read camera status, request fresh frames,
read weather, analyse, write incidents, notify configured household
recipients, retry within limits, verify resolution.

## Notifications and follow-through

- **One alert per incident.** `athena_guard_notification` is unique on
  (incident, profile, kind). A recheck that sees the same open garage door
  updates `last_verified_at` and notifies no one.
- **Escalation, not repetition.** If nobody acknowledges within
  `escalateAfterMin` (default 30), one escalation goes to every recipient. One,
  recorded; never a loop.
- **Delivery failure is retried and visible.** A notification no transport
  accepted is `failed`, retried by the next passes (up to 3 attempts), and
  the dashboard says so. The in-app nudge exists regardless. If the primary
  recipient can't be reached, escalation goes to all recipients.
- **Quiet hours hold, they don't drop.** Advisory findings found inside the
  protocol's quiet window are `held` and sent when it ends. Urgent findings
  (garage open at lights-out; umbrella up with damaging weather inside the
  next six hours) are delivered immediately — the same exception
  `weatherAlerts` makes for weather under six hours away. This is not
  Initiative's `piercesQuiet`, which stays on `freeze_risk` alone.
- **Rechecks** run every `recheckMinutes` while an incident is open, up to
  `maxRechecks`, and resolve it automatically when fresh evidence shows the
  safe state ("Garage door verified closed at 10:14 PM").
- **Simulation.** A protocol in simulation mode, or a manual run with a
  scenario, records everything and sends nothing: notifications are written
  as `simulated`, and a scenario replaces the camera with scripted
  observations. Nothing in the engine can trigger a physical device in any mode.
  A simulated run's incidents use `sim:`-prefixed open keys and are closed
  when the run ends, so a test "open garage" can never dedupe away a real one.

## Reports (owner, 2026-10-25)

- **Evening report.** With `reports.evening` on, the nightly sweep (default
  now 21:00) always pushes one summary, `reports.eveningText()`. Problems it
  finds still open incidents, but `raise()` collects them (`defer`) instead of
  notifying; `sendReport()` sends the one report push per recipient and writes
  each incident's alert rows with that delivery, so dedupe, escalation and the
  failed-delivery retry are unchanged. The umbrella is looked at every night
  for the report; without weather risk an "up" umbrella is informational, not
  an incident. When a storm watch comes due in the same pass, the sweep runs
  first so the umbrella isn't pushed twice.
- **Morning report.** `reports.morning` books a `trigger_kind='report'` run
  (`morning:<date>`, default 06:00) with no checks. It reads the night from
  the store — incidents opened, fixed or still open, missed runs, and stranger
  sightings counted per visit — and needs no camera, so the planner (job or
  service) sends it. A morning report more than the overdue window late lapses.
- **Wording is code**, not a model: every claim maps to an observation, and
  an unverified door is a "Heads up", never "All clear".
- **Changing times** moves already-booked runs (their day stays). From chat,
  `set_guardian_reports` (action layer, never standing, household-security
  adults only) changes the two times and the two report switches — nothing else.

## Persistence and idempotency (migration 0093)

- `athena_guard_protocol` — per-household config, enabled flag, version.
- `athena_guard_run` — one row per occurrence; `UNIQUE (household_id,
  protocol_id, occurrence_key)` makes duplicate scheduling a no-op, and a
  guarded `UPDATE … WHERE state='scheduled' OR lease expired` claims it, so
  two dispatchers never observe the same run and a run interrupted by a
  restart is re-claimed after its lease (`attempts` ≤ 3, then `failed` →
  reported as unverifiable).
- `athena_guard_observation` — every check result: status, confidence,
  capture time, freshness, source, evidence media id, model.
- `athena_guard_incident` — `open_key` is set while open and NULL once closed;
  its unique index is the dedupe.
- `athena_guard_notification` — attempts, channel results, held/simulated.
- `athena_guard_event` — the history and policy decisions.

## Configuration

Env (core service): `GUARDIAN_DISPATCH_AUDIENCE` (the service URL the ID token
is minted for), `GUARDIAN_DISPATCH_SERVICE_ACCOUNTS` (comma list of callers
allowed to dispatch: the job's and the task queue's service accounts).
Env (job): `GUARDIAN_DISPATCH_URL` (`<core service URL>/internal/guardian/dispatch`)
and `GUARDIAN_DISPATCH_AUDIENCE`. Optional: `GUARDIAN_TASK_QUEUE` (default the
reminders queue), `GUARDIAN_TASK_SA`. With dispatch unconfigured, the engine
still runs every observation from the service (manual runs, Cloud Task wakes
directly to the service) and the job still reports missed runs.

Per household, in the dashboard: schedule time, recipients, garage cameras and
regions, umbrella camera and region, wind/storm thresholds, quiet window,
autonomy restrictions, simulation mode, enabled.

## Limits imposed by the Eufy integration

- Battery cameras (T8171 SoloCam E30) wake for each fresh frame: every check
  costs battery. Retries are bounded for that reason.
- HomeBase 2 serves one P2P session at a time; a capture while a sibling
  camera is streaming is refused (409) and treated as `unknown`, then retried.
- Fresh capture takes ~6–9 s per camera; a full sweep with retries can take
  over a minute, so it runs in a dispatched request, not in a page load.
- `lastSeenAt` from Eufy's cloud is often days stale even for working
  cameras, so it is shown but never used to decide "offline". Offline means
  the bridge cannot produce a frame now.
- No garage-door sensor or opener is connected; the camera is the only
  evidence, and closing a door is not possible (and would be Level 3 anyway).
- The bridge holds no schedule: an outage of the bridge host or of Tailscale
  produces "couldn't verify" alerts, never silent sweeps.
