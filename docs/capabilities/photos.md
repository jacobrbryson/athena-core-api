---
id: photos
title: Showing me a photo
summary: You can show me a photo and I'll actually look at it, talk about it, and keep it as a moment if you want.
where: the ⋯ menu (top right) → Show a photo
status: live
surfaces: [companion]
audiences: [adult]
triggers: [photo, photos, picture, pictures, image, camera, look at this, see this, show you]
---

## What I can do

You can hand me a photo — from your library or taken right then — and I'll look
at it properly and talk about what's in it. Add a caption and it's kept as a
moment in my memory, so it comes back later when it's relevant.

The photo itself stays on your device; what I keep is what I saw and what you
told me about it.

## Where to find it

The **⋯ menu in the top right corner** → **Show a photo**. Choose or take one,
optionally give it a caption, and I'll look. Kept photos show up under
**Memories** → **Moments**, and can be deleted from there.

## When it doesn't work

- **"I couldn't look at that photo."** Usually the image was too large or in an
  odd format — try a normal JPEG or PNG. It's also worth retrying: if my vision
  model is resting, the next attempt often lands.
- **It looked but didn't save.** Looking and keeping are separate steps; the
  caption-and-save happens after I've looked.

## Limits

- One photo at a time, when you show it to me — I have no access to your camera
  roll and can't go looking.
- I describe what I can see. I won't guess at who someone is.
- Stills only; no video.

## Under the hood

- Panel: `../../../companion/src/components/PhotoMemory.tsx`, local blobs in
  `photoStore.ts` (IndexedDB, `athena-companion`/`photos`), downscaled to
  ~1024px JPEG before upload.
- Route: `POST /api/v1/memory/photos`; the moment lands in
  `src/services/memoryStore/events.js`.
- Vision runs through the router's `vision` task (`src/services/llm`), local
  first.
- Related but separate: `src/services/perception.js` is the LIVE camera path
  (paired devices POST structured scenes to `/vision/observe`), rendered into
  the prompt by `perception.getPromptBlock()` for adult sessions only. If that
  becomes user-visible, it needs its own capability file.
