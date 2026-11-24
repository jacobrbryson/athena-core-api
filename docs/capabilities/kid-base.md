---
id: kid-base
title: Guardian Base
summary: When a kid signs in to Companion, they get their own Base screen: their mission step, quest map, Guardian card, squad and what they've taught me.
where: Companion, signed in as a kid → Base (left rail: Base, Missions, Athena, Team, Me)
status: partial
surfaces: [companion]
triggers: [countdown, next mission, when does the mission start, coming up, clues i found, my trail keys, my map piece, past missions, try i spy, practice i spy, demo i spy, base, my move, your move, guardian card, my level, level up, squad, squad feed, team, missions tab, quest, what did i teach, taught athena, xp, i spy, ispy, play i spy, spy with my little eye]
---

## What I can do

When a kid signs in to Companion with their own account, they don't see the
grown-up dashboards. They get Base, made for a tablet held sideways:

- **Your move**: the mission step I've asked them to do, in quest words, with
  the Stay Safe rules always showing. **I'm on it!** opens it (that starts its
  timer) and **It's done** finishes it when the step is theirs to finish. A step
  that needs a secret code gets a box for the code. If I check a step myself,
  like seeing them on a camera, the card says so. When nothing is asked, it
  says all is quiet and offers to talk to me.
- **Mission map**: the quest's steps as a trail. Done steps are lit, the one
  they're on glows, and later steps stay locked, so nothing gets spoiled. It
  also shows the clues found.
- **You taught Athena**: what a finished quest really helped me practice, and
  how far my abilities have grown.
- **Squad feed**: how many clues all the Guardians on the adventure found this week, then the latest finds, first names only, with times in plain words ("yesterday", "last month").
- **Guardian card**: their level, role, top skill and XP toward the next level (like 20 / 25).

When nothing is asked, Your move shows their counts (clues found, trail keys, map
pieces, missions) and their last quest. Each count is a button that opens its
list: which clue cards they found, which trail keys they cracked, the map piece
they reported, and the missions they started, each with when. An opened step
shows a countdown ring, and a photo step has a **Take the photo** button that
uses the tablet camera.

**Next mission countdown**: when a grown-up has set when they plan to start an
approved mission, and the kid has nothing to do right now, Base swaps the
mission map for a **Next mission** card. It shows the mission's quest name, the
day and time, and a ticking countdown. When it reaches zero it says "Any minute
now!"; the mission still starts only when a grown-up presses Go.

The other tabs are **Missions**, in three parts: **Now** (Your move, the story
so far and the trail), **Coming up** (each dated mission with its countdown,
then a locked "???" card for every other mission they're in that hasn't started
or is still only a grown-up's plan, so nothing is spoiled or promised), and
their shelf of **quest books** for every quest they were part of (my missions,
with what each really helped me learn, and the Guardians-app missions like The
First Watch, with what they did on each), **Team** (their own squad first, a Specialists strip of who in their
family has which skill, then every squad on the adventure by family name, each
opening to its Guardians with level badges, never a ranking), **Me** (their full
card, skill bars, a badge wall where unearned badges are mystery silhouettes,
their field kit with what each tool is for, and settings: the family stop word,
sounds on or off, and sign out) and **Athena**, which is our chat with their
quest and the stop word shown across the top. The page checks for new steps on its
own every half minute, so it works without notifications.

## I Spy

When a grown-up starts the I Spy mission, Your move shows **Play I Spy**. Thomas,
Skylar and I take turns as the spy, in that order. On a kid's turn, they snap a
photo on their tablet, type the clue ("something blue") and their secret answer,
and I guess from the photo. They tell me if I'm right and can give me a hint.
After three misses, their answer teaches me. On my turn, a kid snaps the room,
I pick something in it and give the clue, and everyone guesses. Every third miss
I give a hint, and they can give up so I say what it was. Twelve finished rounds
finish the mission, and the kids earn the 🔎 Taught Athena I Spy badge when a
grown-up wraps it up. The photos are kept for the grown-ups' debrief.

A parent can try it first: on Companion → Guardians → Missions, the I Spy
mission's card has **Try I Spy yourself**. It opens the kids' own game screen
for a four-round practice, the parent against me. I really look at their photos,
with the same model and words the kids get, but nothing is saved: no rounds, no
photos, and it doesn't count toward the mission's twelve.

## Where to find it

Sign in to Companion with the kid's own account. Base opens by itself. The
rail on the left switches tabs; on a narrow or upright screen it moves to the
bottom.

A grown-up sets the countdown on Companion → Guardians → Missions: a mission
that's approved but not live has **Kids' countdown to**, a date and time, with
Save and Clear.

## When it doesn't work

- **"You're not on a Guardians team yet"**: a parent hasn't added this kid to
  Guardians, so I have no missions or level for them.
- **No step showing when one was expected**: a step only appears once I've
  actually sent it, while the mission is live. A parent can check the mission
  on their Guardians page.
- **"Athena can't reach Base right now"**: the connection dropped. It tries
  again on its own.
- **No countdown**: a grown-up hasn't set when the mission starts, or the kid
  already has a step to do (Your move comes first then). The mission still shows
  as a locked card under Coming up.
- **The countdown hit zero and nothing started**: the countdown is only the plan;
  a grown-up still has to press Go.

## Limits

- Kids can't approve, plan, pause or suggest missions here. Those stay with
  adults on the Guardians page.
- No cameras, codes, controls or other families' details, beyond first names.
- Levels and roles are worked out from what the kid has really done. They
  aren't stored, and they aren't a ranking.

## Under the hood

**Never sent to a model.**

- Backend: `src/controllers/guardianMissions.js` (`asKid`, `kidHome`, `kidTrails`; the kid step handlers are shared with the Guardians app's `/my-steps`)
- Frontend: `../../../companion/src/components/KidHome.tsx`, `../../../companion/src/components/kid.css`, `../../../companion/src/api/kid.ts`; switched on in `../../../companion/src/pages/CompanionConsole.tsx` (`useKidHome`, `.companion-kid` hides the adult top bar and mobile nav)
- Routes: `GET /api/v1/guardian-missions/kid-home`, `POST .../kid/steps/:uuid/{seen,code,done}`, `POST .../kid/go/:uuid`, `POST .../kid/steps/:uuid/photo` (8 MB body in server.js). All need `requireAuth` and a child profile (audience not adult); the actor is the profile's own `kind='kid'` row, never one named in the body.
- I Spy: `src/services/guardianMissions/ispy.js` (+ test), `../../../companion/src/components/IspyGame.tsx`, routes under `/kid/ispy`; migration 0124 (proof `game`, `athena_gm_ispy_round`); the mission is proposed by `scripts/draftIspy.js --write` and still needs approval and Go. A kid's guess is graded by code against her answer and aliases; her guess is graded by the spy. Photos are `athena_gm_photo` rows on the starter's game step. A parent's practice game is `../../../companion/src/api/ispyDemo.ts` (the game lives in the browser) calling the stateless `/ispy-demo/{guess,pick,check}` routes (`demoGuess`, `demoPick`, `demoCheck` in ispy.js), shown from `PracticeGame` in `../../../companion/src/components/GuardiansPage.tsx` when the mission's `game` is `ispy`.
- Notes: an adult gets 403 from kid-home, and that is how the console decides which screen to draw (remembered in localStorage `companion_kid:<profile uuid>`). Mock: `localStorage.mock_kid = 'true'` in `npm run dev:mock`.
- Countdown, Coming up, the counters' lists and past Guardians-app missions: `kidPlans`, `legacyPast` and `record` in `src/controllers/guardianMissions.js` `kidHome`, `memberDetail` in `src/services/guardianMissions/team.js`; the start time is `athena_gm_mission.planned_for` (migration 0125), set by `setPlannedFor` (+ `plannedFor.test.js`) through `POST /guardian-missions/missions/:uuid/schedule`, from `PlannedFor` in `../../../companion/src/components/GuardiansPage.tsx`. Kid screens: `NextMissionCard`, `Countdown`, `RecordSheet` in `../../../companion/src/components/KidHome.tsx`.
