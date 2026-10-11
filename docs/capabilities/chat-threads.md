---
id: chat-threads
title: Chat threads and persistent approval cards
summary: I keep approval cards in chat and can continue a conversation in a thread, with reminder and coding updates attached.
where: Companion chat → Reply in thread beneath a message
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [thread, threaded, reply to, approval card, authorization prompt, chat history, reminded me, reminder history]
---

## What I can do

My profile picture appears to the left of my replies and the messages I bring
up myself in Companion chat, including replies inside a thread. Your messages
stay on the right. If my picture cannot load, an A appears in its place.

I keep my action approval cards with the reply that introduced them. Returning
to chat restores the card and its saved outcome: pending, working, done,
declined, expired or failed. Completed cards stay in the conversation.

You can tap **Reply in thread** beneath any saved message to continue that
conversation. My reply stays in that thread too. A correction still needs a
new approval card; replying does not approve anything.

When a time or place reminder posts its in-app notification, I also keep that
occurrence in the original thread, with its timestamp. That means the reminder
was posted, not that you saw it or that a push reached your phone. Coding
findings and pull request status updates also appear under the original request.
An action marked done means its immediate operation finished; coding may still
be working afterward.

## Where to find it

Open **Chat** in Companion. Tap **Reply in thread** beneath a message, then type
or speak your reply. **Back to chat** returns to the full conversation.
Use **Load earlier messages** or **Load earlier replies** for older history.

## When it doesn't work

- I refresh background updates about every twenty seconds while chat is open.
  Reopening chat also restores them. A failed connection can delay updates.
- An expired card stays visible but cannot be approved. Ask for a fresh one.
- If earlier history fails to load, use the load button again.

## Limits

Threads are in the Companion web chat. The Android and Guardians apps do not
yet offer this thread view. Temporary prompts outside the action approval
system, such as camera permission requests, do not yet become saved cards.
Old action cards are recovered when their originating reply can be identified;
I cannot reconstruct a missing original conversation. Reminders set outside
a chat-linked action have no original thread to update.

Coding updates refresh when the conversation is opened; they do not add a new
background scheduler. I show findings as the agent's report, not verified fact.
A merged pull request does not prove successful deployment. I only show
messages and action details your account is already entitled to see.

## Under the hood

- `../../../companion/src/pages/CompanionConsole.tsx`: chat and thread messages reuse `../../../companion/src/components/AthenaAvatar.tsx` for my profile picture.
- `src/services/message.js`: durable reply targets, privacy and presence filtering, history pages.
- `src/services/chatThreads.js`: current action hydration and idempotent reminder/coding updates; appendActionUpdate is the sink for future outcomes.
- `src/controllers/message.js`: validates reply roots and retrieves thread context.
- `src/controllers/gemini.js`: saves and broadcasts action and thread links.
- `db/migrations/0061_chat_threads.up.sql`: message links, occurrence dedupe and legacy card recovery.
- `src/services/chatThreads.test.js`: privacy, dedupe and honest coding status coverage.
