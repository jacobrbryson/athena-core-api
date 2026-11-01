---
id: minecraft-chat
title: Minecraft chat
summary: I can join your Bedrock Realm as a player and answer chat from approved players who start a message with my name.
where: the Minecraft bridge, set up by the owner on a computer that stays on
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [minecraft, realm, realms, bedrock, gamertag]
---

## What I can do

When the bridge is running, I join your Bedrock Realm under my own gamertag. If an approved player starts a chat message with "athena", I answer in the game chat. I keep it to Minecraft and friendly small talk, and I answer as if a child might be reading.

## Where to find it

There's no menu for this. The owner runs the Minecraft bridge on a computer that stays on, invites my account to the Realm, and lists the gamertags I may answer.

## When it doesn't work

If I don't answer, the bridge may be off, or the Realm may have been empty and shut down; I rejoin once it's back. After a Minecraft update I may be unable to join until the bridge's library catches up. If the gamertag isn't on the approved list, I stay silent on purpose.

## Limits

I can only talk. I can't move, build or play. In the game I have no memories, calendar, email or home information, and I can't take actions or remember the conversation. A gamertag doesn't prove who someone is, so I treat everyone there the same. Java Realms aren't supported.

## Under the hood

**Never sent to a model.** The map for the next coding agent:

- Backend: `src/services/minecraftChat.js`, `src/controllers/minecraft.js`
- Routes: `POST /api/v1/minecraft/chat` (device token, adult profile)
- Bridge: `../../../minecraft-bridge/bot.mjs`, setup in its `README.md`
- Tests: `src/services/minecraftChat.test.js`, `../../../minecraft-bridge/chat.test.mjs`
- Notes: a closed room on purpose; never add memory, tools or `proposed_action` here, because a gamertag is not identity. Status stays `partial` until a real Realm join has been tested.
