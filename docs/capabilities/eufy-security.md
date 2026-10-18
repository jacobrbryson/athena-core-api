---
id: eufy-security
title: Household security
summary: I can show household Eufy status, events and fresh camera images, record short clips, and keep images and clips in private cloud storage.
where: the left menu → Property → Security
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [eufy, homebase, security camera, doorbell, solocam, property security, camera clip, saved camera images]
---

## What I can do

I can show the HomeBase 2, T8213 doorbell, and two SoloCam E30 devices, including available battery readings and last device reports. I can show received doorbell and motion events. An authorized adult can request a fresh image from the doorbell or either E30. Those three fresh-image paths worked through Companion and the private bridge on 2026-10-18.

Every fresh image is kept in the household's private cloud bucket. Each camera card has a record button that captures a 15-second clip, which is kept and starred as important. The Kept clips & images strip lists them newest first. Someone can show only the starred ones, enlarge an image, play a clip, star or unstar either, or delete it permanently. A camera card shows its latest kept image until someone asks for a fresh one.

## Where to find it

The left menu → Property → Security. Kept media is under the cameras. The owner manages Eufy sign-in on the private household bridge host.

## When it doesn't work

If the bridge is offline or the Eufy session expires, the page reports unavailable or authorization required. If cloud storage is down, a fresh image still shows but is not kept, and a clip fails rather than being lost silently. The owner can sign in again on the bridge host. A device may be discovered while its media remains unavailable.

## Limits

The doorbell press and Backyard E30 motion events were received. Motion from the other E30 was not observed after two owner triggers, so its event delivery remains unverified. Stored thumbnails were unavailable in testing. Clip recording is new and has not yet been tested on the real cameras. Kept media stays until someone deletes it; there is no automatic expiry. I cannot stream live video or change device settings from this page. Each motion, person or doorbell event sends one frame for the sightings log (see `sightings.md`); I don't record clips on my own, I alert only for sighting alerts someone set, and I never put camera images into a conversation. Fresh captures may take several seconds to wake a battery camera. Device status can be stale even when an on-demand image works.

## Under the hood

- Bridge: `../../../eufy-bridge/server.mjs`, `../../../eufy-bridge/login.mjs`.
- Backend: `src/controllers/propertySecurity.js`; authenticated adult profile allowlist and media access audit. `src/services/securityMedia.js` keeps media in the bucket `athena-security-media` (env `SECURITY_MEDIA_BUCKET`) with rows in `athena_security_media` (migration 0082).
- Frontend: `../../../companion/src/components/PropertySecurity.tsx`, `../../../companion/src/api/propertySecurity.ts`.
- Routes: GET `/api/v1/projects/property/security` and, under it, GET `/devices/:serial/snapshot`, POST `/devices/:serial/clip`, GET `/media`, and GET/PATCH/DELETE `/media/:id`.
- Bridge clip endpoint: GET `/v1/devices/:serial/clip?seconds=5-30`.
