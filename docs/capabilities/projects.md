---
id: projects
title: Projects
summary: I keep your projects across every part of life — steps, what each needs first, the concerns behind them — ordered by what matters most.
where: the left menu → Projects (everything) or Home (the house); tap any project to edit it
status: live
surfaces: [companion]
audiences: [adult]
triggers: [on track, bulk, gain weight, lose weight, weight goal, workouts this week, connected data, project, projects, progress photo, before and after, journal, house projects, around the house, home projects, to do list, honey do, diy, program, concern, concerns, charter, priorities, what should i work on, next step, blocked, deadline, renovation, contractor, crawlspace, insulation, garage, yard, landscaping]
---

## What I can do

I hold your projects — the goal, the status, the steps, rough effort and cost
(what it'd cost you yourself and hired out), the season and weather it needs,
and a hard deadline if there is one. A project can belong to more than one part
of your life, with one as its home: coaching can be Community and Family at
once.

Projects connect. One can be **part of** a bigger program — painting the office
is part of the interior painting program — and one can **need another first**:
painting the garage waits on finding the smell. While something it needs is
still open, I show it as blocked, and it unblocks itself when that's done.

I also keep **concerns** — the problems your projects exist to solve, like a
musty crawlspace — and your **charter** for an area: your vision, your rules,
and how much each kind of value counts to you. I order your projects from those
in plain arithmetic: priority, how serious the open concerns behind them are,
your charter's weights, and how close a deadline is. I can tell you why
something is near the top.

Each project has a journal: photos marked concept, before, progress, after or
memory, plus notes, decisions and measurements. Photos of your own projects are
stored privately and only come back to you. **Photos of children never leave
your device** — on a project that involves children, or any photo you mark as
having children in it, only the caption is saved and the picture stays on the
phone or computer that took it.

You can also tell me in chat — "I finished the gutters", "add buying batts to
the attic project", "start a project to fix the fence" — and I'll propose the
change for you to approve, naming the project as it appears in your list.

A project can also read data I already have, live — **Connected data** in the
project: your **weight** from the smart scale (compared with the straight line
from your start to your target across the project's dates, so I can say "on
track", "ahead" or "behind" and by how much), your **WHOOP workouts** for the
sports you pick (sessions per week, the last one), and **calendar events**
whose titles contain words you choose (the next 60 days). The plan line also
appears on the Health page's Weight panel.

Right Now uses this list: a project that fits your free time, in season, with
the weather it needs, can be what I suggest. Work projects stay on your Work
page and off the Dashboard.

## Where to find it

- **Projects** in the left menu: every project, filterable by area, with a
  search box and **New project**. Tap one to open it.
- **Home** in the left menu: the house — open projects, programs with their
  parts, your concerns, and your charter.
- Health, Family and Community each show the projects that touch them, and
  Work has its own Work projects panel.
- The Dashboard has a **Projects** card and a **Home** card.

Inside a project you can change anything: Start, Mark done, Hold (and say what
it's waiting on), Drop or Reopen in one tap, plus every field, its steps (add,
tick off, reorder, remove), its connections to other projects, and the concerns
it answers, plus **Photos & notes** — Add a photo (pick its phase and a caption)
or add a note or decision. Delete is at the bottom and asks first — Drop keeps
the history.

## When it doesn't work

- **"Projects are unavailable right now."** The server can't read the projects
  tables — usually the projects database update hasn't been installed yet.
  Nothing is lost; try again once it has.
- **A link was refused.** I won't let two projects wait on each other, or make
  something part of its own part. Remove the other link first.
- **"Photos of children stay on your device."** That project involves
  children, so I can't store the picture — add it again and it will be kept on
  this device with just its caption saved.
- **A photo says "Kept on the device that took it".** It's a device-only photo
  taken on another phone or browser, or that device's storage was cleared.
- **Connected data says "That source isn't connected" or "Health data
  sharing hasn't been agreed to."** Link the scale, WHOOP or Google Calendar in
  Connected apps (and agree to health data sharing for the scale), then reopen
  the project.
- **No plan line.** The project needs a target and start/end dates — the
  Target and When sections.
- **Something shows as blocked that you think is ready.** Open it and look at
  "Needs first" — one of those is still open. Finish or drop it, or remove the
  link.

## Limits

- I don't change your projects myself. In chat I propose the change and you
  approve it; everything else is you, in your app.
- I don't order materials, call contractors or price jobs yet — costs are
  numbers you or your import gave me.
- Connected data covers weight, WHOOP workouts and calendar events so far —
  not Jira, GitHub, email or contacts yet. Only weight has a target line; I
  don't track nutrition.
- Calendar matching looks ahead 60 days only, by words in the title.
- I don't look at your photos or describe them; a photo is what you captioned it.
- Device-only photos don't sync between your devices.
- Sharing a project with your household isn't available yet; every project is
  private to you.

## Under the hood

**Never sent to a model.** The map for the next coding agent:

- Backend: `src/services/projects/index.js` (CRUD, graph read),
  `src/services/projects/shape.js` (validation, derived status, cycle check),
  `src/services/projects/rank.js` (ordering and the Right Now mapping),
  `src/services/projects/importFile.js` (seed from a reviewed JSON file),
  `src/services/projects/entries.js` (journal + photos; the children rule is
  enforced here), `src/services/projects/bindings.js` (connected data: selectors, live reads,
  the weight plan arithmetic), `src/services/projects/prompt.js` (the chat prompt block,
  wired in `src/controllers/gemini.js`), actions `add_project` /
  `update_project` in `src/services/actions/registry.js`
- Frontend: `../../../companion/src/components/Projects.tsx`,
  `../../../companion/src/api/projects.ts`,
  `../../../companion/src/components/ProjectJournal.tsx`,
  `../../../companion/src/components/ProjectData.tsx`, pages in
  `../../../companion/src/components/Dashboard.tsx` (ProjectsPage, HomePage, areaStrip)
- Routes: `GET|POST /api/v1/projects`, `PATCH|DELETE /api/v1/projects/:uuid`,
  steps/links under it, `/api/v1/projects/concerns[/:uuid]`,
  `PUT /api/v1/projects/charters/:area` — `src/controllers/projects.js`,
  `src/routes/projects.js`, behind `requireAdultActor`. Every write answers with
  the whole snapshot.
- Schema: `db/migrations/0069_projects.up.sql`, `0070_project_entries.up.sql`, `0071_project_bindings.up.sql` (replaces `athena_home_project`
  from 0037, which was empty and is no longer read)
- Script: `scripts/importProjects.js <profileId> <file.json> [--apply]` — a
  one-time seed; re-runs only create missing keys and never overwrite app edits
- Tests: `src/services/projects/projects.test.js`, `entries.test.js`,
  `actions.test.js`, `bindings.test.js`, `src/services/rightNow.test.js`
- Notes: design is `docs/architecture/projects.md`. "Blocked" is derived from
  open `depends_on` links (a dropped dependency holds nothing up); the stored
  status is what the person set. Season is a 12-bit month mask. `indoor` stays
  three-valued. Household visibility is rejected until a household model exists.
  Photos: bucket `PROJECT_MEDIA_BUCKET` (default `athena-project-media`, no
  lifecycle), objects `projects/<projectUuid>/<entryUuid>.<ext>`, served by
  `GET /api/v1/projects/:uuid/entries/:entryUuid/image`; uploads are base64 JSON
  under the 8 MB parser in `src/server.js`. A project can't be switched to
  involves-children while it holds stored photos.
