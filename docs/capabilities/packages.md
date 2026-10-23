---
id: packages
title: Packages at the door
summary: I notice packages the door cameras see left behind, look again later to see if they're still there, and match them to delivery emails.
where: Property → Security → Sightings (filter Packages; add "A package is left" under Alerts to your phone)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [package, packages, parcel, delivery, deliveries, delivered, on the porch, at the door, box, walmart order, amazon order, did my order come, has it arrived, still there]
---

## What I can do

When a camera's frame shows a box, mailer, bag or envelope left on the porch,
step or driveway, I log it as a **package**: which camera, when, and what it
looked like ("small brown box on the doormat").

About an hour later I take a fresh look from that camera and compare it with
the first picture: still there, or gone. If it's still there I look again a
couple of hours later, up to three looks in all. When it's gone, I note who
the camera saw next, if anyone. If you've set a package alert, I tell you
when it's **still sitting there**.

If Gmail is linked, I also read shipping notices — Walmart, Amazon, UPS,
USPS, FedEx and the like — so a package on the porch can be "your Walmart
order", and if an email says something was **delivered but no camera saw a
package**, I tell you that too.

Ask "did my Walmart order come?" or "is there a package on the porch?".

## Where to find it

**Property → Security → Sightings.** Set **Show** to **Packages** to see them.
To be told, under **Alerts to your phone** choose **A package is left**, and
optionally a camera. That alert covers all three: the package arriving, it
still being there, and a delivery email with nothing on camera.

Alerts come through Initiative, so it has to be on, and they're held during
quiet hours.

## When it doesn't work

- **A package was there and I didn't log it.** A small mailer in a dark corner
  of the frame is easy to miss; nothing was logged if the camera sent no
  picture with its motion event.
- **I never said whether it was still there.** The second look comes from the
  household camera bridge; if the bridge restarted in between, that look is
  lost and the package shows as "couldn't be re-checked".
- **No order name.** Gmail isn't linked, or the shipping email didn't say when
  it was delivered closely enough to match.

## Limits

- **I see what the cameras see.** A package left out of view, or behind a
  pillar, isn't seen; "delivered but not seen" means exactly that, not that
  it's missing or stolen.
- **"Who took it" is just who the camera saw next** on that camera — not proof.
- **Up to three looks**, about an hour and then two hours apart. Each look may
  wake a battery camera.
- I can't contact the carrier, file a claim or reorder anything.
- Shipping emails are read for the order's state only; I keep the latest
  state per order for 60 days. Package sightings are kept 30 days like other
  sightings; the later look's picture isn't kept at all.

## Under the hood

- Packages in sightings: `src/services/sightings.js` (`FRAME_KINDS`, label is
  always "package", never a gallery subject; rules may use label `package`).
- Porch watch: `src/services/packageWatch.js` (athena_package_watch, migration
  0088). The bridge keeps the re-check timer: the webhook's answer carries
  `recheck: [{ deviceSn, watch, afterSeconds }]` and the bridge posts event
  kind `recheck` with a fresh frame (`../../../eufy-bridge/server.mjs`),
  because Cloud Run jobs can't reach the tailnet bridge.
- Webhook: `src/controllers/eufyEvents.js`.
- Deliveries: `src/services/deliveries.js` (athena_delivery, migration 0089),
  fed from `src/services/emailTriage.js` after classification.
- Triggers `package_waiting` and `delivery_not_seen` in
  `src/services/initiative/triggers.js`, both gated on a `package` rule.
- Chat: the `sightings` need adds porch watches and deliveries for package
  questions (`src/services/needs.js`).
- Tests: `src/services/packageWatch.test.js`, `src/services/deliveries.test.js`.
