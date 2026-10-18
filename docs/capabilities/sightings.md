---
id: sightings
title: Camera sightings
summary: I log who and what the home cameras see — known people, pets and vehicles by name, anyone else as a stranger — and can alert you about the ones you choose.
where: the left menu → Property → Security → Sightings
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [last saw, last see, did you see, have you seen, was the dog out, dog out, dog escaped, got out, in the yard, at the door, stranger, who was, who came, sighting, sightings, seen on camera, back fence, red van, white suv]
---

## What I can do

When a household camera sees motion, a person or a doorbell press, the bridge
sends me one frame. I compare it with the gallery — the people, pets and
vehicles you've named, with up to three reference photos each — and log every
living thing and vehicle in it: who (by name when it clearly matches, otherwise
"stranger" for a person or something like "deer" or "white pickup"), which
camera, where in the scene, which zone if you've named the camera's zones, and
how sure I was.

Ask "when did you last see Wynter?" and I'll answer from that log — for
example "3:32 pm today, by the back fence, on the Backyard camera" — and say
so when the camera wasn't sure.

You can set alerts like "tell me when Wynter is seen on the Backyard camera
outside the back fence" or "tell me when a stranger is at the Doorbell". I send
them to your phone like my other alerts: only if alerts are on for you, once
per occurrence (a dog seen three times in ten minutes is one alert), and held
until quiet hours end.

## Where to find it

The left menu → Property → Security → the Sightings card. **Log** lists recent
sightings and shows each frame. **Gallery** adds names: give a name, kind and
short description, then add reference photos from kept images (take a fresh
image while they're in view first). **Alerts & zones** sets alerts and names
the areas each camera sees.

## When it doesn't work

- **Nothing in the log.** The bridge on the household computer has to be
  running and set to send events. Battery cameras may also be asleep; motion
  wakes them.
- **The wrong name, or "stranger" for someone you know.** Add clearer reference
  photos (face and full body, in daylight) and a description. Night and
  distance make names unreliable, so I fall back to a generic label.
- **An alert didn't arrive.** Alerts must be on in Initiative settings, and
  anything during quiet hours waits until they end.

## Limits

Only authorized adults in the household can see sightings or the gallery, and
only they can ask me about them. Sightings and their frames are kept 30 days,
then deleted. Removing someone from the gallery deletes all their sightings
and alerts. I never try to identify a stranger beyond calling them a stranger.

Recognition is the vision model's best judgement from one frame — reliable
for distinctive pets and vehicles in daylight, much less so for people at a
distance, from behind or at night, and the model may decline to name people
from faces at all. Each motion event takes one extra snapshot, which uses
camera battery. Events while the bridge or Athena is down are not logged
later. Motion frames are not kept unless something was seen in them.

## Under the hood

- Bridge: `../../../eufy-bridge/server.mjs` posts each event and one frame to `ATHENA_EVENTS_URL` with the bridge token.
- Ingress: proxy `POST /api/v1/webhooks/eufy` → core `POST /webhooks/eufy` (`src/controllers/eufyEvents.js`).
- Service: `src/services/sightings.js` — gallery, zones, identification (task `vision`), log, rules, 30-day prune (nightly `sightingsPrune`).
- Alerts: initiative trigger `sighting_alert` (`src/services/initiative/triggers.js`).
- Chat: the `sightings` need (`src/services/needs.js`), adults in `EUFY_AUTHORIZED_PROFILE_IDS` only.
- Tables (migration 0083): `athena_sighting_subject`, `athena_sighting_subject_photo`, `athena_camera_zone`, `athena_sighting`, `athena_sighting_rule`. Frames in `gs://athena-security-media/sightings/`.
- Frontend: `../../../companion/src/components/SecuritySightings.tsx`.
