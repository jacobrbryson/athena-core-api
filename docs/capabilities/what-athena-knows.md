---
id: what-athena-knows
title: What Athena knows
summary: I can show you everything I can see about you — each linked account and what I read from it, what I remember, and the other things I hold.
where: your name (sidebar) or More (phone) → What Athena knows
status: live
surfaces: [companion]
audiences: [adult]
triggers: [what do you know about me, what do you know, what can you see, what can you access, privacy, what data, what information, who can see, delete my data, do you have my]
---

## What I can do

I keep one page that answers "what do you know about me?" without you having to
ask me. For every account you can link it says whether it is linked, what I read
from it, whether I can change anything in it, and when I last read it. Under that
is a count of what I remember, grouped by kind, and the other things I hold that
did not come from an account: photos you kept, your community list, the family
health watch, news pages you chose, and what I build overnight while dreaming.

I read linked accounts when a question needs them. I do not keep a copy of your
inbox or calendar.

## Where to find it

Open your name at the bottom of the left sidebar (or More on a phone) and choose
What Athena knows. The page links straight to Connected apps to link or unlink an
account, and to Memories to read or delete anything I remember.

## When it doesn't work

If the page says it couldn't read your connected apps, reload; if it still
fails, Connected apps will say why. If an account says "needs reconnecting", I
can't read it until you reconnect it there.

## Limits

This page describes what I can reach; it does not show the contents. To see a
specific memory, open Memories. The "what I read" lines are fixed descriptions of
each account, not a record of each thing I looked at. Removing a link stops my
reads from then on, and deleting a memory removes it from what I remember.

## Under the hood

**Never sent to a model.**

- Frontend: `../../../companion/src/components/KnowsPanel.tsx`; opened from the
  menu in `../../../companion/src/pages/CompanionConsole.tsx`.
- Data: `GET /api/v1/integrations` (`integrationsApi.list`) and the memory facts
  read (`memoryApi.facts`). No new endpoint.
- Notes: the per-provider "reads / writes" text is a static map in
  `KnowsPanel.tsx` (`READS`). When a connector is added or its scopes change,
  update that map and this file together or the page will understate what
  she can see.
