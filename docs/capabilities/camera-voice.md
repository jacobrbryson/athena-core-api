---
id: camera-voice
title: Speaking Through A House Camera
summary: I can say a short message out loud through the doorbell, driveway or back yard camera, with your OK on the exact words each time.
where: Ask me in chat; there's no button for it in the app
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [say through the camera, say through the doorbell, tell them through the camera, speak through the camera, talk through the camera, through the doorbell, through the driveway camera, through the back yard camera, through the backyard camera, over the camera speaker, announce outside, camera speaker]
---

## What I can do

I can say something out loud, in my voice, through the speaker on one of the
house cameras: the **doorbell**, the **driveway** camera or the **back yard**
camera.

Ask me something like "tell the kids through the back yard camera that dinner's
ready". I'll put a card in our conversation showing which camera and the exact
words, for example: Say through the Back Yard camera: "Dinner's ready!".
Nothing plays until you tap **Approve**. I only tell you it worked once the
camera has taken the audio.

## Where to find it

Just ask me in the Companion app. There's no camera speaker button. The parents'
**Test** button for it is on the **Guardians** page, under **Field Kit** →
**Capabilities**, and it plays a fixed test line instead of your words.

## When it doesn't work

- **"There is no camera called …"** I list the cameras I can see. Name one of
  them.
- **"That camera can't play sound."** Not every camera has a speaker I can use.
- **"The cameras at home can't be reached."** The computer at home may be off
  or offline. Try again in a minute.
- **"Control is off."** The home bridge hasn't been set up to send commands.
  That's the owner's to turn on.
- **"The kill switch is on."** The Guardians kill switch cuts my control of the
  lights and cameras. A parent can turn it off on the Guardians page, under
  **Field Kit**.
- **"Speak through camera is switched off."** That's its own switch under
  **Field Kit** → **Capabilities** on the Guardians page.

## Limits

- **Every message is a card you approve,** with the exact words on it. I can't
  speak through a camera on my own, and there's no "don't ask me again".
- **Once it plays, it can't be taken back.** Anyone near that camera hears it.
- **One camera and up to 300 characters per message.** I won't shorten a longer
  one. I'll ask you to.
- **I only speak. I don't listen back.** I can't hear a reply through the camera
  or hold a conversation through it.
- **Only the household adults who can see the cameras** can use this from chat.
- It hasn't been tried on the real cameras yet, so the first few times may not
  play.

## Under the hood

- Action: `say_through_camera` in `src/services/actions/registry.js` (owner's
  instruction 2026-11-11; never standing, not reversible). `availableTo` needs
  the bridge configured, `EUFY_AUTHORIZED_PROFILE_IDS`, a parent actor and a
  `speak_through_camera` capability row (family 1 only). `normalize` matches the
  camera name against the bridge's live device list and requires
  `control.talkback`. It stores `camera_serial`, so a model-written serial is
  never used. Tests: `src/services/actions/sayThroughCamera.test.js`.
- Speaking: `announce` in `src/services/guardianMissions/house.js`. It goes
  through `house.permit` as a parent (mission mode ignored, kill switch and
  capability switch apply). Voice comes from `llm.speech`, wrapped as a WAV. It
  logs `speak_through_camera_command` and deliberately writes no
  `athena_gm_test_result`, so everyday use can't move ability scores. The Test
  button and camera-check greetings still go through `say`, which does record.
- Home: `../../../eufy-bridge/server.mjs` `POST /v1/devices/:serial/talk` needs
  `EUFY_BRIDGE_CONTROL=on`, and converts the audio to AAC with ffmpeg.
