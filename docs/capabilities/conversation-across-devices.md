---
id: conversation-across-devices
title: One Conversation On Every Device
summary: Signed in, you get the same conversation with me on your phone, laptop or the Guardians console, so you can pick up where you left off.
where: sign in as yourself on any device; nothing to turn on
status: live
surfaces: [companion, guardians, learning]
triggers: [other device, another device, my phone, my laptop, new phone, pick up where, where we left off, lost our conversation, don't remember, forgot what we, started over, new conversation, cleared, different computer]
---

## What I can do

When you're signed in, there's one conversation between us, not one per
device. Start something on your phone and open me on your laptop, and I'm in
the same conversation, knowing what we were just talking about.

If a device still had an older conversation of its own, I fold it into the
current one the next time you open me there, so nothing either device heard
disappears.

## Where to find it

Nothing to turn on. Sign in as yourself — the Companion app, the Guardians
console, or the phone app — and I pick up our latest conversation.

## When it doesn't work

- **I started over.** You're probably not signed in on that device, or you're
  signed in as a different person. A visitor who isn't signed in gets a
  conversation that stays on that device.
- **An old conversation didn't come across.** I only bring a device's old
  conversation over when that device is opened again. One you no longer use
  stays where it was, though what I learned from it is still in my memory.
- **A conversation stayed separate.** If someone else joined that conversation
  with you, I keep it apart, because merging it would let them see what you
  said elsewhere, or let you see what they said.

## Limits

- **One conversation per mode.** A learning session and an open-ended chat
  stay separate threads.
- **Texts follow their own rule.** A text to me joins whichever of your
  conversations started most recently in the last day, or starts a new one.
- **A device that's already open keeps showing what it had** until you reload
  or reopen it. Anything you say there still ends up in the same history the
  next time either device opens.
- **I can't recover a conversation from before you signed in on a device**
  after its network has changed. Sign in first and that can't happen.

## Under the hood

**Never sent to a model.**

- Resume + merge: `src/services/session.js` — `latestForProfile` (most recently
  active session the profile owns in that mode), `mergeSessionInto` (moves
  `message` and the profile's `athena_action` rows, widens the owner's span,
  rewinds `memory_extraction_cursor`; refuses if anyone else is a participant
  of either session), `resumeForProfile`
- Controller: `src/controllers/session.js` — binds an unbound session to the
  PROVEN caller (`resolveCallerProfileId`), not just the client's `profile_uuid`;
  a caller with no usable stored uuid resumes `latestForProfile`
- Legacy cause: the Guardians app never sent `profile_uuid`, so its sessions
  stayed anonymous and IP-pinned, and both apps keyed the conversation by a
  per-browser `localStorage` uuid
- Tests: `src/services/session.test.js`, `src/controllers/sessionResume.test.js`
- Notes: binding backdates the owner span to `session.created_at`; otherwise the
  fail-closed transcript filter hides everything said before the bind.
  The source session row is left in place (empty), so a stale tab still
  writing to it is folded in again on its next open.
