# WHOOP activity reviews: operation and acceptance

Implemented first slice of the continuous-attention proposal. It does not add
autonomous provider writes, notifications, physical schema evolution, or general
commitments. No deployment or live provider test is implied by source completion.

## Setup

1. Apply migration `0036_attention` through the existing owner-run migration
   procedure. Runtime credentials only need the ordinary DML permissions for
   these new tables; do not give the runtime migration/grant privileges.
2. Deploy core_api, proxy_service and Companion together. Core mounts
   `POST /webhooks/whoop` with raw-body parsing before the ordinary session
   boundary. This is authenticated by WHOOP's SHA-256 HMAC, not by a browser
   session. Other methods and endpoints retain normal access checks.
3. Register `https://<proxy-origin>/api/v1/webhooks/whoop` as a **v2** webhook in
   the same WHOOP app that supplies `WHOOP_CLIENT_SECRET`. The proxy forwards
   exact request bytes with its existing Cloud Run service identity; the core
   validates the signature and a five-minute timestamp tolerance. Synchronize
   host clocks. It never trusts user/profile IDs from request headers.
4. Schedule the existing core image to run `node src/jobs/attention.js` every
   minute, using the same database, encryption keyring, connector secrets and
   guarded model configuration as the serving app. Use a real job/worker, not
   a post-response promise or request-bound Cloud Run timer. A pass defers excess
   work durably (twenty watches, twenty events each); overlapping passes use leases.
5. Each user connects WHOOP and Google Calendar and explicitly enables Activity
   reviews in Connected apps. Processing requires current health-data consent,
   an adult profile and live Athena access. Each worker enters that profile's
   access context; no owner grant is inherited from a webhook or generated plan.

The source scans a stable seven-day interval, one page per pass, saving its
cursor transactionally with enqueued records. Completed scans recur hourly.
Known resources reviewed within the last seven days are also fetched to detect
removals. Webhook deliveries may concern older resources. This intentionally
does not promise complete historical reconciliation after arbitrarily long downtime.

## Storage and concurrency

- `attention_watch`: explicit owner preference, linked-account identity, cursor,
  generation and five-minute lease. A preference change or correction fences a
  worker that started before it. Different profiles can be processed independently.
- `attention_event`: durable inbox/work row. Distinct resource/type/trace triples
  are recorded; duplicate deliveries are harmless. No health payload is stored here.
  Retry delays grow to an hour and have no attempt-based discard limit.
- `attention_record`: append-only analysis snapshots and an owner's editable
  correction on a snapshot. Original source data and interpretations are separate.
  The payload/correction are encrypted through the existing keyring and registered
  with key rotation. Repeated identical observation/context pairs need no new analysis.

All effect-free analysis runs through the guarded model adapter. Lease expiry,
worker crash, or user correction cannot let a late model output publish over a
newer worker. External account identity is checked against provider responses.
Deletion webhooks cause a fresh GET, so an out-of-order deletion does not remove
an activity that the source currently returns. Missing results are distinguished
from explicit deletions and provider outages.

Calendar reads cover the historical activity interval and paginate. Failures or
an exceeded completeness bound stop inference. Memory selection is generic text
relevance against the activity/calendar, with no coaching/frisbee rule. The shared
interpreter accepts evidence IDs, requires supporting context for relabeling and
cannot invoke actions. Corrections are examples, not self-granted rules or grants.

The UI/prompt hide derived reasoning when a referenced memory was forgotten or
replaced, or the calendar account changed. Old encrypted snapshots are retained
until Forget; these are private records, not shared memories. Forget deletes the
watch, queue, snapshots and corrections and fences in-flight publication.

## API

- `GET /attention/whoop`: private owner status and latest thirty resource reviews.
- `PUT /attention/whoop` with `{ "enabled": true|false }`: explicit preference.
- `POST /attention/whoop/recheck`: enqueue recent reviews and a source scan.
- `POST /attention/whoop/reviews/:uuid/feedback`: `{ "kind": "confirm"|"correct",
  "label": "...", "note": "..." }`. Only the latest review can be corrected.
- `DELETE /attention/whoop`: forget the feature's stored data and disable it.

These routes use the ordinary access boundary and authenticated adult-profile
resolution. They never accept a target profile ID. The proxy prefixes `/api/v1`.

## Acceptance before calling this live

Use an explicitly authorized test account and actual provider credentials:

- Create overlapping coaching/calendar and workout records. Check evidence,
  uncertainty and the unchanged original WHOOP label.
- Exercise a genuinely unrelated workout and ambiguous overlapping appointments.
- Confirm/correct once, then review a later matching and a nonmatching activity.
- Replay a signed duplicate, alter the body, change account IDs and send stale
  timestamps. Only authentic, opted-in deliveries can enter the queue.
- Stop a worker mid-analysis and wait for its lease to expire. Verify a subsequent
  worker resumes and the old worker cannot publish after a generation change.
- Change/delete the calendar entry, disconnect sources, revoke health consent,
  withdraw Athena access and delete a supporting memory. Verify the documented
  blocked or invalidated state rather than a invented replacement explanation.
- Simulate a provider timeout, a missing resource and multiple pagination pages.
  Verify cursors only move with durable enqueues and failures remain visible.
- Confirm review data is private to the owner. Test both browser and paired-device
  routes, children, and another adult attempting the same review UUID.

Source-level tests use mocked providers/models and SQL boundaries; they do not
substitute for these live-account and MySQL concurrency checks.

WHOOP contract: https://developer.whoop.com/docs/developing/webhooks/
Workout API: https://developer.whoop.com/api/
