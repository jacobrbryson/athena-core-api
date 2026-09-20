---
id: house-projects
title: Projects Around The House
summary: I keep your around-the-house list — what it is, how long it takes, indoors or out — and use it to fill an afternoon when going out isn't on.
where: the Dashboard → Places & projects → Projects
status: planned
surfaces: [companion]
audiences: [adult]
triggers: [house projects, around the house, to do list, honey do, garage, yard work, home projects, diy, chores list, jobs around the house, spreadsheet of projects]
---

## What I can do

I hold the list of work waiting around your house — the title, which room or
part of the yard, roughly how long it takes, whether it's indoor or outdoor
work, what it might cost, and what it's waiting on if it's stuck.

Two of those do real work. **How long it takes** is how I know whether
something fits the gap before your next appointment, so a two-hour job is the
answer to a three-hour afternoon and a full weekend job isn't. **Indoors or
out** is how I know what to suggest when the weather has ruled out going
anywhere.

If your list already lives in a spreadsheet, you can paste it in. I'll read the
headers the way they're written — "Task", "Room", "Est. Hours", "Not started" —
show you what I made of them, and only save once you've looked.

## Where to find it

Dashboard → **Places & projects** → the **Projects** tab. Add one with the
form, or open **Bring in a spreadsheet** to paste an existing list. Tapping a
project's status walks it forward: to do → in progress → done.

To bring in a Google Sheet: File → Download → Comma-separated values, open the
file, and paste the whole thing. Copying the rows straight out of the sheet
works too.

## When it doesn't work

- **The import put everything in one column.** Your sheet probably has no
  header row, so I treated the first column as the title and left the rest.
  Add a header row — "Task, Room, Status, Est. Hours" — and paste again.
- **It skipped rows.** I tell you how many and why; the usual reason is a row
  with no title in it, which is what a blank separator line looks like to me.
- **A column didn't come across.** I name the ones I couldn't place. I only
  understand the handful of fields above; anything else is worth putting in the
  notes column, which I do keep.

## Limits

- Importing adds; it doesn't reconcile. Pasting the same sheet twice gives you
  two of everything.
- I don't sync with your spreadsheet. Once the list is here, here is where it
  lives — changes in the sheet won't follow.
- I can't order materials, book a trade, or price a job. A cost on a project is
  a number you typed.
- I won't tick anything off, add anything, or delete anything by myself. If I
  think something's done, I'll ask.

## Under the hood

**Never sent to a model.** The map for the next coding agent:

- Backend: `src/services/homeProjects.js`,
  `src/services/homeProjectsImport.js`
- Frontend: `../../../companion/src/components/PlansPanel.tsx`
- Routes: `GET|POST /api/v1/dashboard/projects`,
  `PATCH|DELETE /api/v1/dashboard/projects/:uuid`,
  `POST /api/v1/dashboard/projects/import` — `src/controllers/rightNow.js`,
  behind `requireAdultActor`
- Schema: `db/migrations/0037_right_now.up.sql`
- Tests: `src/services/homeProjectsImport.test.js`
- Notes: the import is delimiter-sniffing (a clipboard paste is TSV, a download
  is CSV) and the header map lives in `HEADERS`. `indoor` is deliberately
  three-valued — null means nobody said, and `rightNow.js` only rewards a
  project for being indoors when it actually knows. A row's status is read from
  words people type; "Not started" is checked before "started" for the obvious
  reason. The chooser is `projectCandidates` in
  `src/services/rightNow.js`.
