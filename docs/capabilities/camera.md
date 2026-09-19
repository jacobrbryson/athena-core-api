---
id: camera
title: Seeing Through A Camera
summary: I can look through a camera on your device, take a fresh look each time you message me, and — if you allow it — take a look on my own when it would help.
where: the camera button by the message box → Let her see
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [what do you see, can you see, look at this, what do you think about this, camera, webcam, what is in front of you, watch the room, look around, describe what you see, turn on the camera, flip the camera, switch camera]
---

## What I can do

Turn on my sight and I look through a camera on your device and tell you what
is there. Ask me "what do you see?" and I answer from a real look, not from
memory.

**I take a fresh look every time you send me a message.** So "what do you think
about this?" is answered from the view at that moment — point the camera at
something and ask, and I'm looking at the thing you're pointing at rather than
at whatever was there a minute ago.

Between messages I also look on my own, as often as you tell me to. On a phone
you can flip between the front and back camera, which is usually what you want:
the back one for showing me something, the front one for talking.

My sight stays on once you turn it on — closing the panel doesn't stop it.
While I can see, there's an eye in the top bar. Tap it to see what I'm seeing
or turn it off.

**If you allow it, I can also take a look on my own** when seeing would answer
what we're talking about. I always say why, the screen says so while it's
happening, and I close the camera again straight afterwards. You allow that
once, in the camera panel, and you can take it back whenever you like — after
which I go back to asking you each time.

If something is worth remembering, I keep a note of what I saw. I never keep
the picture.

## Where to find it

The camera button next to the message box → **Let her see**. It's also in the
menu under the same name. Your browser asks permission the first time.

**Turn off her sight** in that panel, or tap the eye in the top bar to get back
to it. **Look now** takes an extra look, and the flip button switches cameras.

## When it doesn't work

- **The camera won't open.** The browser blocked it. Allow camera access for
  this site in the address bar, then try again.
- **She's describing the wrong thing.** She looks when you send a message, so
  point the camera first and then ask. If you flipped cameras, give it a second.
- **I keep saying I can't see anything right now.** A look counts as current
  for twenty seconds. Send a message and she'll take a fresh one.
- **She said she'd look and nothing happened.** Her request waits for an open
  app to answer it and expires after ninety seconds. If the tab was closed or
  the camera was refused, she was declined — the Actions panel shows it.
- **She stopped on her own.** After three failed looks she stops rather than
  keep trying — usually her vision model is unavailable. The Brain panel says.

## Limits

- **I don't know who anyone is.** I can tell you there are two people in the
  room. I cannot tell you which two, even if they are people I know well.
  Recognising faces is not something I can do.
- **I can only look on my own while you allow it.** Without that permission
  every look happens because you opened the panel, pressed a button, or sent me
  a message. With it, I can still only ask — your device decides whether to
  answer, and it always shows you when it does.
- **I can't look when nothing of yours is open.** A look needs an app of yours
  running to answer it, and requests go stale after a minute and a half. I
  can't check in on a room you've walked away from.
- **I can't point the camera.** I can say which of your cameras would help;
  I can't move one.
- **Only while the app is open.** Leaving the app, signing out, or closing the
  tab ends it. I can't watch in the background.
- **Only on the device you turned it on.** This is that device's camera, not
  something you can leave in a room and check from elsewhere.
- **I look, I don't watch continuously.** Between looks I have no idea what
  happened. Something that appears and goes in the gap is something I missed.
- **I can't hear anything.** No microphone is used.
- **What I saw fades.** A look is current for twenty seconds and I can refer
  back to the last ten minutes. Beyond that, only anything I thought worth
  remembering survives.

## Under the hood

**Never sent to a model.**

- Frontend: sight lives in `../../../companion/src/athena/useSight.ts` (owned by
  the console, NOT the drawer — see the note below); controls in
  `../../../companion/src/components/CameraPanel.tsx`; API binding `visionApi`
  in `../../../companion/src/api/companion.ts`; JPEG encode shared with photo
  memories via `../../../companion/src/components/photoStore.ts`
- Routes: `POST /api/v1/vision/observe` (stores the scene, feeds the prompt;
  `look_request_id` in the body closes the request that frame answers),
  `POST /api/v1/vision/describe` (structures one frame, stores nothing),
  `GET /api/v1/vision/look-requests`, `POST /api/v1/vision/look-requests/:uuid/decline`
- Looks she asks for: the `look_through_camera` action in
  `src/services/actions/registry.js` (standing-approvable), which executes by
  writing an `athena_look_request` — `src/services/lookRequests.js`,
  `db/migrations/0033_look_request.up.sql`. The grant is the ordinary
  `athena_action_authority` row, so the Actions panel revokes it like any other.
- Tests: `src/services/lookRequests.test.js`, `src/services/actions/actions.test.js`
- Backend: `src/services/perception.js`, `src/controllers/companion.js`
- Mock: `../../../companion/mock/client.ts` returns a canned room so
  `npm run dev:mock` exercises the whole loop without a vision model
- Notes: sight is deliberately NOT owned by the drawer. The first version tore
  the stream down on close, so closing the panel blinded her — which is not
  what anyone means by "let her see". `useSight` keeps its own hidden <video>
  (1px and in the DOM, because a detached video may stop decoding and a stalled
  video reports `videoWidth === 0`, which looks exactly like a broken camera);
  the drawer attaches a second element to the same stream just for preview.
  Because sight now outlives its panel, the top-bar eye is load-bearing, not
  decoration. `LIVE_TTL_MS` is 20s, but the cadence matters much less now that
  `onSubmit` takes a look before sending — capped at `LOOK_BEFORE_SEND_MS` so a
  slow vision model cannot hold up the conversation. `scenes` is an in-memory
  Map, so the live view is per-process and does not survive a restart. The
  device half of perception (the Unity Android fast loop) is unrelated to this
  panel and has still never been built.

  On looks she asks for: the action layer executes server-side and a camera is
  not on the server, so `execute()` records a request and the client answers
  it. The client BORROWS the camera and gives it back — a look she asked for
  must never leave her holding a live camera she was not granted — and
  `athenaLooking` raises the indicator before `getUserMedia` is called, not
  after the frame returns, so a camera that fails to open is still visible as
  an attempt. Revoking the standing approval stops requests being written at
  all; turning sight off only ends the background loop.
