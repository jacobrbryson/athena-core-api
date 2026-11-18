---
id: sprint-progress
title: Sprint Progress
summary: Your and the Red team's story points in the open Jira sprint against the 64-point target, who's behind, and PRs reviewed vs created.
where: Work → open your workspace → Sprint Progress (Overview, Jira and Team tabs); a summary sits in the Dashboard's Work section
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [sprint, story points, story point, velocity, behind, on track, at risk, 64 points, reviewed to created, review ratio, who's behind, team progress, burndown]
---

## What I can do

On a workspace's dashboard I show the open sprint from that workspace's Jira:
your story points done, in progress and not started, then the Red team's
average, and — when you tap **Show the Red team** — every developer on it. Only
the Red team counts: someone is on it when any of their issues in the sprint has
Red in its Jira Team field (or a red-team label), and then all their sprint
issues count. If the sprint itself is named for Red, everyone in it is. Each person
is measured against the 64 points every developer needs by the end of the
sprint, with how many they still need and where the team should be today.

Each person gets a status: **Complete** (64 done), **On track**, **At risk** or
**Behind** — the team's chip is its worst member's, not the average's. Behind means the points they still need — counting in-progress work
as half finished — are more than anyone could finish at the 64-a-sprint rate in
the working days left, or the sprint simply holds fewer than 64 points for them
past its halfway point. At risk is close to that line, or short of 64 points of
work. The rule is fixed arithmetic, not my judgement.

Beside the points I show pull requests from the workspace's GitHub since the
sprint started: how many each person reviewed (not their own), how many they
created, and the reviewed-to-created ratio.

The Dashboard's Work section shows the short version: your points and status,
your review ratio against the team average, and who on the team is behind or
at risk. Tap it to open the full card.

The Home **Work** card also lists the Red team's open epics under **Active
Work**, soonest due first, with how far along each one is. An epic counts as
the Red team's when Jira's Team field or a red-team label says so, or when the
Red team's sprint work rolls up to it. Its % complete is story points done of
the total under it, or child issues done of total when they aren't pointed.
Due dates come from the epic's Due date, or its Target end when it has no due
date.

## Where to find it

Open **Work**, then the workspace card (for example Vivacity Tech PBC). The
**Sprint Progress** card is at the top of Overview and also under the **Jira**
and **Team** tabs. On the main **Dashboard**, it's at the top of the **Work**
section, for your primary workplace.

## When it doesn't work

- **"This GitHub key can't see the team's pull requests".** The workspace's
  GitHub token doesn't reach the repositories where the team works. For a
  fine-grained token: Repository access → All repositories (or pick the team's),
  Pull requests: Read, Metadata: Read, and organization Members: Read.

- **"No Red team found in Jira · showing everyone".** No issue in the sprint
  has a Team field naming Red or a red-team label, and the sprint's name
  doesn't say Red, so I can't tell who's on it. Set the Team field on the Red
  team's issues.

- **"No Jira connection is linked to this workspace yet."** Link the Jira
  connection to the workspace (Work → the workspace's pencil → linked apps).
- **"…needs this workspace's Jira connected with an API token."** Sprint
  progress reads Jira by API token only; reconnect Jira that way.
- **"No sprint is open in this Jira right now."** Nothing is in an active
  sprint; it returns once the next sprint starts.
- **A developer says "No GitHub match".** I match Jira names to GitHub accounts
  in the workspace key's organizations by name and common login shapes; their
  GitHub profile may have no name set. Their points still count.
- **GitHub not linked / unavailable** shows beside the sprint name; the story
  points still show.
- Numbers refresh at most every five minutes.

## Limits

- Red team only (the owner's choice); there's no switch to another team yet.
  You always see your own row.
- One sprint: the Red team's open sprint, else the one you're in (or the busiest one if you're in none);
  other open sprints are only named.
- Story points come from Jira's Story Points / Story point estimate field;
  sub-tasks aren't counted, and unassigned points are shown as a total only.
- PRs reviewed counts pull requests you reviewed that were updated since the
  sprint began, so a PR reviewed before the sprint but touched since can count.
  Only the GitHub organizations that the workspace's key belongs to are searched.
- The 64-point target is the same for everyone; there is no per-person capacity
  or time off yet.
- I can't change anything in Jira or GitHub from here — it's read-only.

## Under the hood

- Service: `src/services/workspaceSprint.js` — `read(profileId, uuid|'primary')`,
  `statusOf` (the danger rule, `TARGET_SP = 64`), `matchLogin` (Jira name →
  GitHub login), `elapsedFraction` (Mon–Fri days), `isRedTeam` (`TEAM` regex over the Team
  field(s) found in `/field`, or a `red-team` label) — the Red-only filter. Uses `credentialFor` from
  `src/services/workspaceDashboard.js`, so only the workspace's own linked
  Jira (API token) and GitHub keys are read, never another workspace's.
  Jira: `/rest/api/3/field` (sprint + story-point field ids, cached a day),
  `/myself`, `search/jql` with `sprint in openSprints()`. GitHub: `/user`,
  `/user/orgs`, org members + `/users/{login}` names (cached a day), then two
  `search/issues` counts per person (3 at a time). Result cached 5 minutes per
  workspace and per key (a sha256 fingerprint of each token, in memory only), so a
  replaced key never sees the old key's result; errors and GitHub notes aren't
  cached, nor are empty member lists.
- Red epics: `jiraRedEpics(key, redParents)` in the same service — `search/jql`
  `issuetype = Epic AND statusCategory != Done ORDER BY duedate ASC` (up to 3
  pages), kept when `isRedTeam` or its key is a parent of Red sprint work
  (`redParents` from the sprint read), then `parent in (…)` 40 keys at a time
  for children's status and points. Returned as `epics: { items, error }` on the
  sprint response, read even when no sprint is open; an epics error isn't cached.
- Route: `GET /api/v1/dashboard/workplaces/:uuid/sprint`
  (`src/controllers/workplaces.js` `sprint`, `src/routes/companion.js`).
- Frontend: `../../../companion/src/components/SprintCard.tsx` (`SprintPanel`,
  `SprintSummary`, `useSprint`) + `../../../companion/src/components/sprint.css`;
  mounted in `../../../companion/src/components/WorkspacePage.tsx` (`#ws-sprint`)
  and in the Home Work section of `../../../companion/src/components/Dashboard.tsx`.
  Mock in `../../../companion/mock/client.ts`.
- Tests: `src/services/workspaceSprint.test.js`.
