---
id: shared-conversations
title: Talking With More Than One Of You
summary: More than one guardian can take part in the same conversation, and I keep the thread when you swap accounts on a shared device.
where: sign in as yourself on the device the conversation is already open on
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [switch accounts, switched accounts, both of us, my wife, my husband, my partner, we are both, someone else here, hand over, take over, who is here, who can see this]
---

## What I can do

If two of you are in the room and one signs in on the device the other was
using, I stay in the same conversation. I don't start over — I know what we
were just talking about, and I carry on from there.

Once there's more than one of you, I keep track of who said what, and I'll use
your names so it's clear who I'm talking to. Whoever is signed in right now is
the one whose calendar, memories and connected apps I'm working from, and the
one who has to approve anything I offer to do.

I'll tell you who's in a conversation if you ask.

## Where to find it

Nothing to turn on. Sign in as yourself on the device where the conversation is
already open and I'll carry on rather than starting a new one.

It only works between people in the same family, and only for adults — a child
can't join somebody else's conversation, though a parent can join theirs.

## When it doesn't work

- **I started over instead of carrying on.** You're probably not in the same
  family account as the person who started it, or you're signed in as a child
  profile. Both of those mean I open a fresh conversation rather than hand you
  somebody else's.
- **I used the wrong name.** I use the name your family set for you, falling
  back to the name on your account. Change it in the family settings and I'll
  use the new one.
- **A child is here and I'm still being careful.** That's deliberate. If anyone
  in the conversation is a child, I stay on the child-safe settings for all of
  us until they leave — signing in as an adult doesn't change who's in the room.

## Limits

- **There's no privacy between you.** Everyone in a shared conversation can read
  all of it, including the part before they signed in. If you want to tell me
  something the other person shouldn't read, use your own device.
- **I only remember it for the person who started it.** In a shared
  conversation, I take long-term memories from the turns of whoever the
  conversation belongs to. What the second person says is something I can see
  and reply to, but not something I'll remember about them later.
- **Being here doesn't let you approve things.** Anything I offer to do is
  approved by whoever is signed in, against their own permissions. Sitting in
  the room doesn't give anyone authority they didn't already have.
- **I don't know who's speaking out loud** — only who's signed in. If you're
  sharing a screen, I'll attribute what's typed to the account that typed it.
- **No one has left yet.** I can represent somebody stepping out of a
  conversation, but nothing asks me to yet, so in practice everyone admitted
  stays until the conversation ends.

## Under the hood

**Never sent to a model.**

- Membership + policy: `src/services/sessionParticipant.js` (`mayJoin` is the
  only gate; `admitToSession` in `src/services/session.js` is the only place
  membership is granted, and it audits)
- Authorization: `src/services/session.js` — `getAuthorizedSession` recognizes
  membership but can never create it
- Speaker attribution: `message.profile_id`, `src/services/message.js`
- Prompt: `src/controllers/prompt.js` — `multiParty` names speakers and adds
  the "Who is here" block; single-speaker sessions are byte-identical to before
- Audience: `src/services/audience.js` — most restrictive participant, fails
  closed to `child`
- Memory: `src/services/memoryStore/extract.js` — filters to the owner's turns
- Migration: `db/migrations/0030_session_participant.up.sql`
- Tests: `src/services/sessionParticipant.test.js`, `src/services/session.test.js`
- Notes: a joiner's span is backdated to the session's `created_at`, not the
  moment they signed in. Starting it at the switch would hand them an empty
  transcript and leave Athena nothing to continue — which is the bug this
  exists to fix. `Number(null)` is `0` and passes `Number.isFinite`, so profile
  ids go through `profileNum()` before any access decision.
