# Projects

Status (2026-10-13): **phases 1 and 2 built, not yet deployed.** 1a: tables (0069), service,
API, importer, Right Now switch-over, the Home section and full editing in the Companion app.
1b: journal + photos (0070; children's photos device-only, enforced server-side) and the
add_project / update_project chat actions. 2: bindings (0071) — weight, WHOOP sport,
calendar match — with the plan line on the Health weight panel. Bindings are added by the
owner (confirmed at once); Athena-proposed bindings wait for phase 4's suggestion pass.
Migrations 0069–0071 are not applied yet.

## Why this exists

Projects is the weakest section of the Companion dashboard and arguably the most
important one. Today it is three unrelated panels (`companion/src/components/Dashboard.tsx`,
`ProjectsPage`):

- **Websites**: Search Console + GA4.
- **Jira projects**: assigned issues grouped by Jira project key.
- **Goals**: `user_memory` facts in the project category.

Meanwhile `athena_home_project` (migration 0037) holds the around-the-house list.
It feeds only the Right Now card (`src/services/rightNow.js`) and never appears on
the Projects page at all.

None of these know about each other or about the rest of Athena. The owner's
real projects show why that matters. Each one is mostly *data Athena already
has*, scattered across sections:

| Project | Dates | Data that already exists | What's missing |
|---|---|---|---|
| +20 lb muscle, look bigger/stronger | 2026-10-05 → 2027-03-05 | VeSync weight (daily), WHOOP workouts (3 gym / 1 run / 1 MTB a week), calendar | A target line, nutrition, weekly progress photos |
| Porch steps (logs, rocks, mulch, accent lighting) | in progress | — | Remaining steps, before/progress/after photos, the concept that was settled on |
| Coaching U10 + U12 soccer | ~08-03 → 10-22 | Game/practice events on the calendar, soccer strain in WHOOP | Rosters, schedule, standings, strategy notes, photos |
| E-commerce store launch | — | Jira epic (Jira connector exists, read-only) | The link to the epic |
| Attic + crawl-space insulation | **before winter** | Weather | A hard deadline, contractor contacts, quotes |
| Orcwood hotfixes | recurring | Jira, GitHub, `fix_code` | The link from issue to PR to deploy |
| 20–40 other house projects | — | `athena_home_project` rows | Everything but the row |

## Principles

1. **A project is a lens, not a container.** It stores what only it can hold:
   the goal, the steps, the journal, the photos. Everything else it *binds to*
   and reads live. Weight stays in the health store, games stay on the calendar,
   and the epic stays in Jira. Nothing is copied, so nothing drifts.
2. **Bindings are proposed, then confirmed.** Athena may suggest that an
   event, workout or issue belongs to a project. A confirmed binding is a stored
   selector, and after that it is code, not a model guess, that decides what
   matches. This is what makes the data string together automatically without
   silently mis-filing things.
3. **Help is generated, not enumerated.** Nobody can list every way Athena can
   help. Suggestions come from matching the project's state against the
   capability catalog (`docs/capabilities/`), so a new capability becomes a new
   kind of help with no projects code changing.
4. **Anything with side effects goes through the action layer.** A suggestion
   can carry a `proposed_action`. It is executed only by the existing
   propose → approve → audit sequence. Projects adds no execution path.
5. **Photos of children never leave the device.** See [Media](#media-and-the-children-rule).

## Data model

Next free migration number at time of writing is 0069. Another session may have
taken it, so check before naming.

### `athena_project`

```sql
CREATE TABLE athena_project (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,             -- owner of the project
  title VARCHAR(190) NOT NULL,
  goal TEXT NULL,                          -- "look bigger and stronger", in their words
  kind VARCHAR(32) NULL,                   -- soft hint: fitness | home | coaching | work | ops | program | ...; never an ENUM
  -- Status is where the work stands, nothing else. "Urgent" is a priority,
  -- "waiting on rain" is a waiting_on, and "today's top choice" is computed by
  -- Right Now, never stored.
  status ENUM('idea','planning','ready','active','waiting','blocked','done','dropped') NOT NULL DEFAULT 'idea',
  waiting_on VARCHAR(32) NULL,             -- rain | season | person | delivery | quote | ... (when status = waiting)
  priority TINYINT UNSIGNED NOT NULL DEFAULT 3,  -- 1 low · 2 low-medium · 3 medium · 4 high · 5 critical
  starts_on DATE NULL,
  ends_on DATE NULL,                       -- planned end (coaching season ends 10-22)
  hard_deadline DATE NULL,                 -- consequence if missed (insulation before winter)
  -- Optional measurable target. On-track is arithmetic, never a model's opinion.
  metric_source VARCHAR(48) NULL,          -- e.g. 'health:weight'
  metric_start DECIMAL(10,2) NULL,
  metric_target DECIMAL(10,2) NULL,
  metric_unit VARCHAR(16) NULL,
  -- Ranges, because real estimates are ranges ("3–5 hours", "$1,500–7,000").
  -- effort_* carry athena_home_project's effort_minutes so Right Now keeps working.
  effort_min_minutes INT UNSIGNED NULL,
  effort_max_minutes INT UNSIGNED NULL,
  effort_note VARCHAR(64) NULL,            -- "plus cure", "1–2 Saturdays", "inspection first"
  indoor TINYINT(1) NULL,                  -- NULL = nobody said; never guessed
  cost_diy_low DECIMAL(10,2) NULL,
  cost_diy_high DECIMAL(10,2) NULL,
  cost_pro_low DECIMAL(10,2) NULL,         -- installed / hired out
  cost_pro_high DECIMAL(10,2) NULL,
  cost_note VARCHAR(190) NULL,             -- "TBD after inspection", "before incentives"
  value_note VARCHAR(255) NULL,            -- the ROI judgement, in words
  -- When it can be done. Months are a bitmask (bit 0 = Jan); conditions are
  -- weather the forecast can answer, so Right Now and suggestions can match them.
  season_months SMALLINT UNSIGNED NULL,    -- NULL = anytime
  conditions JSON NULL,                    -- ["dry","mild"] | ["warm","dry"] | ["during_rain"] | ["no_freeze"]
  serves JSON NULL,                        -- charter goal keys: ["safety","resale","maintenance",...]
  import_key VARCHAR(64) NULL,             -- stable id from an import file; re-running an import updates, never duplicates
  involves_children TINYINT(1) NOT NULL DEFAULT 0,  -- see Media
  visibility ENUM('private','household') NOT NULL DEFAULT 'private',
  cover_entry_id BIGINT UNSIGNED NULL,
  last_progress_at DATETIME NULL,
  completed_at DATETIME NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'manual',  -- manual | chat | import | migrated
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_project_uuid (uuid),
  UNIQUE KEY uq_athena_project_import (profile_id, import_key),
  KEY idx_athena_project_open (profile_id, status, priority),
  KEY idx_athena_project_deadline (profile_id, hard_deadline)
);
```

Small one-hour house jobs are projects with zero steps. We don't need two
concepts for "task" and "project". Steps are for a checklist *inside* one
project (the porch's bottom step, plants, lighting). Anything with its own cost,
season or status is a project, linked to its program.

### `athena_project_link`: programs and dependencies

The owner's house list proved projects form a graph, not a list. "Paint office",
"Paint halls" and "Paint kitchen" all feed an interior painting program. "Garage
cleanout" feeds *both* the odor diagnosis and the storage master plan. And "Paint
garage" can't start until the odor is diagnosed.

```sql
CREATE TABLE athena_project_link (
  from_project_id BIGINT UNSIGNED NOT NULL,
  to_project_id BIGINT UNSIGNED NOT NULL,
  relation ENUM('contributes_to','depends_on') NOT NULL,
  note VARCHAR(190) NULL,            -- "confirm cracks are non-structural first"
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (from_project_id, to_project_id, relation)
);
```

- `contributes_to` is many-to-many. A **program** (`kind='program'`) is just a
  project that others contribute to. Its progress rolls up from its contributors,
  and it may also have steps of its own.
- `depends_on` replaces free-text `blocked_on`. A project with an unfinished
  dependency **is** blocked: the status is derived, not typed. When the
  dependency finishes, it unblocks and can be suggested. The owner's decision rule
  ("survey before fence, lawn plan before irrigation, moisture diagnosis before
  crawlspace work") becomes data.
- The service rejects cycles.

### `athena_concern`: the problems projects exist to solve

A pain point is not a project. "Crawlspace is moldy" isn't finished when one
project ships. It's resolved when someone observes it's gone, and it ties to
several projects.

```sql
CREATE TABLE athena_concern (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  area VARCHAR(16) NOT NULL,
  title VARCHAR(190) NOT NULL,
  severity TINYINT UNSIGNED NOT NULL DEFAULT 3,  -- same 1–5 scale as priority
  frequency VARCHAR(64) NULL,        -- "during rain", "daily", "winter"
  likely_cause TEXT NULL,
  goal_impact VARCHAR(255) NULL,
  assessment TEXT NULL,              -- current thinking, rewritten as it changes
  status ENUM('open','monitoring','resolved') NOT NULL DEFAULT 'open',
  resolved_at DATETIME NULL,
  import_key VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_concern_uuid (uuid),
  UNIQUE KEY uq_concern_import (profile_id, import_key)
);

CREATE TABLE athena_concern_project (
  concern_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (concern_id, project_id)
);
```

An open concern raises the ranking of the projects linked to it. Finishing every
linked project does **not** resolve it. Instead, Athena suggests checking ("the
gutters and encapsulation are done; is the crawlspace still musty?").

### `athena_area_charter`: how this person decides

The owner's "Goals & Priorities" sheet is a charter for the whole area, not a
project: a vision, weighted values, and decision rules ("diagnose before buying",
"visible progress has real value", "a project should solve multiple problems").

```sql
CREATE TABLE athena_area_charter (
  profile_id BIGINT NOT NULL,
  area VARCHAR(16) NOT NULL,
  body TEXT NOT NULL,                -- the vision and rules, in their words (Markdown)
  weights JSON NULL,                 -- {"safety":10,"emergency_prep":10,"wildlife":7,"energy":5,...}
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, area)
);
```

The suggestion pass and the ranking both read it. A project's `serves` keys are
looked up in `weights`. That is how a project serving safety + emergency prep
outranks a cosmetic one without a model inventing the order. The ranking is
arithmetic: priority, open concern severity, charter weights, deadline pressure,
and dependencies satisfied. The model writes suggestions *within* that order;
it doesn't set it. Health would later get its own charter (the muscle-gain goal
and its rules).

### `athena_project_area`: overlap with the rest of the app

Projects span sections. Muscle gain is Health, the store is Work, and coaching
is Community but also touches Family and Health.

```sql
CREATE TABLE athena_project_area (
  project_id BIGINT UNSIGNED NOT NULL,
  area VARCHAR(16) NOT NULL,      -- the dashboard's own vocabulary: health | family | community | work | home
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, area)
);
```

- The vocabulary is the dashboard's sections (`DashboardSection` in
  `Dashboard.tsx`), validated in code, not free tags. The card order is already
  fixed by the owner, so the areas already form a closed list. Home gets its
  own new section (owner, 10-13).
- Exactly one primary area per project, enforced in the service. The primary
  decides the card's icon/colour and where it leads. Secondary areas make the
  project appear as a compact strip on those section pages.
- Bindings *suggest* areas. A WHOOP or health binding prompts "also Health?",
  and a Jira binding suggests Work. The owner confirms.

| Project | Primary | Also |
|---|---|---|
| +20 lb muscle | health | — |
| Porch steps | home | — |
| Insulation | home | — |
| Coaching | community | family, health |
| E-commerce launch | work | — |
| Orcwood hotfixes | work | — |

### `athena_project_binding`: how data flows in

```sql
CREATE TABLE athena_project_binding (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  selector JSON NOT NULL,
  status ENUM('proposed','confirmed','rejected') NOT NULL DEFAULT 'proposed',
  proposed_by ENUM('owner','athena') NOT NULL,
  confirmed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_binding_project (project_id, status)
);
```

| `source_type` | Example selector | Read through |
|---|---|---|
| `calendar_match` | `{"title_any":["U10","U12"],"calendar":"primary"}` | Google Calendar connector |
| `calendar_event` | `{"event_id":"..."}` (one specific event) | Google Calendar connector |
| `whoop_sport` | `{"sport":["weightlifting","running","mountain_biking"]}` | `athena_workout` |
| `health_metric` | `{"metric":"weight"}` | VeSync / health store |
| `jira_epic` / `jira_issue` | `{"site":"...","key":"ECOM-12"}` | Jira connector (read-only) |
| `github_repo` / `github_pr` | `{"repo":"athena-core-api","pr":123}` | GitHub (code-fixes path) |
| `contact` | `{"resource_name":"people/..."}` (contractor, vendor) | Google Contacts |
| `email_thread` | `{"thread_id":"..."}` | Gmail |
| `place` | `{"place_id":"..."}` (the hardware store) | Places / place reminders |
| `website` | `{"site":"orcwood.com"}` | Websites monitoring |

Rules:

- **Only `confirmed` bindings are read.** A rejected binding is kept, so the
  same match is not proposed again.
- Selectors are interpreted by code, per `source_type`. The model may *propose*
  a selector, but it never runs anything.
- A binding can only reference a source the person has already connected and
  consented to. Binding does not create new access. It filters access that
  already exists, through the guarded connectors.

This is also where the overlap with existing sections stops being duplication.
The Health page's weight card can draw the +20 lb trajectory when a Health
project binds `health_metric:weight`, and the Calendar shows a project chip on
bound events.

### `athena_project_step`

```sql
CREATE TABLE athena_project_step (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  ordinal INT NOT NULL,
  title VARCHAR(190) NOT NULL,
  detail TEXT NULL,
  status ENUM('todo','in_progress','blocked','done','skipped') NOT NULL DEFAULT 'todo',
  who ENUM('me','someone','athena') NOT NULL DEFAULT 'me',  -- someone = contractor/vendor
  blocked_on VARCHAR(190) NULL,
  due_on DATE NULL,
  effort_minutes INT UNSIGNED NULL,
  indoor TINYINT(1) NULL,
  completed_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_step_uuid (uuid),
  KEY idx_step_project (project_id, status, ordinal)
);
```

A `who='athena'` step is one she can make progress on, for example "get three
insulation quotes". Its progress is always a proposed action, never a direct
write to the world.

Steps also feed Right Now. A 45-minute indoor step is a better answer to "free
hour, raining" than a whole project.

### `athena_project_entry`: the journal

One typed timeline per project.

```sql
CREATE TABLE athena_project_entry (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  step_id BIGINT UNSIGNED NULL,
  type ENUM('note','photo','document','dataset','decision','measurement','excerpt') NOT NULL,
  phase ENUM('concept','before','progress','after','memory') NULL,  -- photos
  body TEXT NULL,                 -- note text, or the description of a photo
  media_location ENUM('server','device') NULL,
  media_uri VARCHAR(512) NULL,    -- gs://... when server; NULL when device
  device_ref VARCHAR(64) NULL,    -- IndexedDB media_ref when device
  parsed JSON NULL,               -- dataset rows, extracted quote figures, ...
  parsed_kind VARCHAR(32) NULL,   -- 'roster' | 'schedule' | 'standings' | 'quote' | ...
  involves_children TINYINT(1) NOT NULL DEFAULT 0,
  taken_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_entry_uuid (uuid),
  KEY idx_entry_project (project_id, created_at)
);
```

**Datasets** are what make coaching work without a soccer schema. An uploaded
schedule or standings table (CSV, screenshot, paste) is parsed once into
`parsed`, with a soft `parsed_kind`. Athena then answers "tough game this
weekend, or a week to experiment?" from the latest standings and schedule
entries. The same type holds contractor quotes and insulation R-value
comparisons.

**Decisions** record what was settled and why, e.g. "logs + rocks + mulch +
accent lighting, chosen over pavers". That way she doesn't relitigate it months
later.

**Measurements** are for numbers no connector supplies, e.g. an arm measurement
taken alongside the weekly photo. Weight is *not* stored here. It is bound.

### `athena_project_suggestion`: "ways I can help"

```sql
CREATE TABLE athena_project_suggestion (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  step_id BIGINT UNSIGNED NULL,
  body TEXT NOT NULL,               -- "I can price the low-voltage path lights at Lowe's and Home Depot"
  capability VARCHAR(64) NULL,      -- which capability file it draws on
  proposed_action JSON NULL,        -- handed to the action layer as-is; never executed from here
  status ENUM('open','accepted','dismissed','done','expired') NOT NULL DEFAULT 'open',
  expires_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_suggestion_uuid (uuid),
  KEY idx_suggestion_open (project_id, status)
);
```

A nightly pass per active project looks at the goal, open steps, recent entries,
bound data and the capability catalog, and writes a few suggestions. Examples
for the current projects:

- **Porch:** find accent lighting that matches the concept, a plant list for
  the light conditions in the photo, or a concept image of the finished bottom
  step.
- **Insulation:** "first freeze forecast is ~N weeks out", "draft an email to
  these three contractors for quotes", or "add a Saturday block to buy baffles
  and R-38 batts".
- **Muscle gain:** "4 weeks in, +X lb against a +4 lb plan", "two gym days
  missed this week; Thursday 6pm is open", or "time for this week's photo".
- **Coaching:** "Saturday's opponent is 2nd in standings; keep the lineup
  tight" or "Sunday is against the last-place team, a good week to experiment".
- **Orcwood hotfix:** "the PR for ORC-88 is green and waiting on review".

Accepting a suggestion that has a `proposed_action` opens the normal approval
card. Accepting one without an action converts it into a step or opens the chat
with it.

Dismissal is recorded, and it may inform what she suggests *next*. It can never
be used to stop surfacing a deadline, a missed workout or anything else true.
This follows the same reasoning that removed the interruption budget: ordering
is allowed, silencing is not.

## Media and the children rule

- **Adults:** photos (progress photos, before/after, concept images) are stored
  server-side in a dedicated private GCS bucket (e.g. `athena-project-media`),
  served through signed URLs, the same way dream images are. **Not** the dreams
  bucket: that one has a 30-day lifecycle rule, and progress photos are meant to
  be kept for years.
- **Children:** the existing photo-memory rule holds. **Photos of children stay
  on the device** (IndexedDB `media_ref`), and the server stores only the
  description. That covers coaching (team photos, game memories), and any Family
  project.
- **How we know:** we never rely on a model deciding there are no children in a
  photo to unlock server storage. A project with `involves_children = 1`
  (coaching is set at creation) stores every photo device-only by default. The
  owner can mark a specific photo "no children" to store it server-side. In any
  other project, the upload sheet asks for the same toggle when the area
  includes Family or Community. Failing safe means device-only.
- Entries with `involves_children = 1` are excluded from dreaming, consistent
  with "children's memories never enter" `athena_mind`.
- Concept images are generated from a "before" photo plus the agreed design,
  using the image model that dreaming already uses (`gpt-image-2`). They are
  stored as `phase='concept'` entries.

## Check-ins (weekly progress photos)

Decided: **suggestion, not initiative.** When a project with a metric target
has gone 7 days without a `phase='progress'` photo, the nightly pass writes an
open suggestion ("time for this week's photo") on the card. It expires when a
photo arrives. Nothing pushes. Making Athena ask first would be an initiative
trigger (`src/services/initiative/`, protected), and the owner chose not to.

## Dashboard

- **Projects card (Dashboard):** the 2–3 active projects with the most pressure
  (closest `hard_deadline`, behind on trajectory, stalled `last_progress_at`).
  Each shows a progress indicator, the next step and the top suggestion. The
  card's position in the fixed card order doesn't change. This orders only what
  is *inside* it. **Work-primary projects never appear here** (owner, 10-13).
  They live on Work and the Projects page.
- **Home section (new):** its own page and dashboard card for home projects,
  steps and photos. It replaces the place `athena_home_project` never had.
- **Progress indicator, by what the project has:**
  - a metric target: actual vs. planned line (+20 lb over 5 months ≈ 1 lb/week)
  - steps: done / total
  - a deadline only: time elapsed vs. remaining
- **Projects page:** every active project grouped by primary area. Each opens a
  detail view with goal, steps, a photo strip (concept → before → progress →
  after), the timeline, bindings with their live data, and suggestions.
  Websites and Jira stop being standalone panels. They are bindings on the
  projects they belong to, e.g. an "Orcwood" project bound to `website` +
  `jira_*` + `github_repo`. Unbound Jira issues still show in Work.
- **Section pages:** a compact "Projects" strip on each area page for projects
  whose primary or secondary area matches.
- **Every card shows its Connect/fix CTA:** a binding whose connector is
  unlinked renders the existing fix CTA, never a hidden blank (owner rule,
  09-29).

## Editing in the Companion app

Owner requirement (10-13): **everything is editable in the app.** That covers
imported rows and anything Athena created. Nothing is import-only or chat-only.

- **Projects:** every field in `athena_project` (title, goal, status,
  waiting_on, priority, dates and hard deadline, cost and effort ranges, season
  months, conditions, `serves`, indoor, metric target), plus areas (add/remove,
  pick the primary).
- **Quick actions on a project card:** mark done, start, put on hold (waiting +
  reason), drop, and change priority. One tap each, no form.
- **Steps:** add, edit, reorder, check off, delete.
- **Links:** add or remove "part of" (`contributes_to`) and "needs first"
  (`depends_on`) from the project detail view, chosen from a project picker.
  Cycles are rejected with a message, not silently.
- **Concerns:** create, edit, link/unlink projects, mark monitoring or resolved.
- **Charter:** edit the body text and weights for each area (Home first).
- **Journal entries:** edit captions/phase, delete, and move to another project.
- **Bindings:** confirm, reject or remove.
- **Delete:** a project can be deleted from the app. It asks for confirmation
  and shows what links to it. Dropping (`status='dropped'`) is the default
  offered, because it keeps history.

Every write goes through `/api/v1/projects/...` routes that check the project
belongs to the signed-in profile. These are the person's own data and are not
actions: no approval card, and no new authority. Edits made by chat use the
same service functions, so app and chat can never disagree on the rules.

## Chat

Projects need to work by voice first, because that's how a project gets
updated while standing on the porch:

- "Add a step to the porch: wire the accent lights" → a step.
- A photo with "porch, after" → an entry. Athena infers the project and phase,
  and confirms when unsure.
- "How's the bulk going?" → reads the bound weight, workouts and recent photos
  and answers from the arithmetic.
- "Is this weekend a tough game?" → the latest standings and schedule datasets
  plus the bound calendar events.
- Creating a project in conversation writes it with `source='chat'` and proposes
  areas and bindings for confirmation.

These are memory-store/actions writes, not new authority. Creating a project,
step or entry is the person's own data, written at their request. Anything that
touches the outside world (email a vendor, buy, call) is an action.

## Visibility and households

`visibility='household'` would let other Guardians in the home see a project,
e.g. a spouse seeing the insulation project and its quotes. Two constraints:

- It is per project, opt-in, and **never inferred from area**. Being a Home
  project does not make something shared.
- **Roster names are owner-only regardless.** A household-visible coaching
  project would still show its children's names only to the owner.
- There is no household entity today ("family" is derived from surname, with no
  `family_id`). Shared visibility therefore waits on a real household model. Phase 1
  ships `private` only, and the column exists so the shape doesn't change later.

## Migration from what exists

1. Each `athena_home_project` row becomes an `athena_project` with
   `kind='home'`, `source='migrated'` and a primary area of `home`. The carried
   fields (`detail` → `goal`, status mapped `todo`→`idea`/`active`,
   `blocked_on` → a blocked step) keep their values.
2. `rightNow.js` reads `athena_project` + open steps instead of
   `athena_home_project`. Keep the old table read-only for one release, then
   drop it.
3. `homeProjectsImport.js` (CSV paste) writes `athena_project` rows.
4. **Reviewed import file.** The owner's house spreadsheet (4 tabs: 26 upgrades,
   41 weekend wins, 12 pain points, a goals sheet) has been hand-mapped into
   `project-import/home/home-import.json` at the **workspace root**, outside
   every repository, so personal house details never reach GitHub or an image.
   The JSON format is what `scripts/importProjects.js` (to be written) consumes:
   - Charter, concerns, projects (with `program` keys), links and steps, all
     keyed by a stable `key` that becomes `import_key`.
   - **Dry run by default.** It prints what it would create or update. `--apply`
     writes, and it runs only against the profile named on the command line.
   - **A one-time seed. After it runs, the Companion app is the source of
     truth.** A re-run only *creates* rows whose `import_key` is missing; it
     never overwrites a row that already exists (the owner edits these in the
     app, and an import must not undo that). `--overwrite` exists for a botched
     first run only. It never deletes.
   - Rows marked `"review": "..."` in the file are questions for the owner.
     The importer refuses to `--apply` while any remain.
   - Applying to production follows the usual rule: the owner says go first.
5. Saved "goals" in `user_memory` stay memories. Athena can *propose* turning
   one into a project, and `user_memory` remains the source of truth for what
   she remembers.

## Capability catalog

Each phase that ships something a person can see or ask about adds or updates
`docs/capabilities/projects.md` and a `LEDGER.md` line in the same commit. This
matters more than usual here: the suggestion generator reads the catalog, so an
undocumented capability is one she will never offer to help with.

## Phases

1. **Core:** the project, area, link, step, entry, concern and charter tables,
   the importer + applying the reviewed house file, full editing in the
   Companion app (see Editing), migrating home projects,
   Right Now switched over, Projects page + detail view, adult photos to GCS,
   device-only for `involves_children`, chat add/update, the new Home
   section (after renaming the overview's internal key), work kept off the Dashboard. *Finish the porch steps in it.*
2. **Bindings, the ones needing nothing new:** `health_metric`, `whoop_sport`
   and `calendar_match`/`calendar_event`, plus the trajectory line on the Health
   weight card. *The muscle-gain project and coaching's calendar come alive
   here.*
3. **Datasets:** upload/paste parsing for schedule, standings, roster and quote.
   Roster names become owner-only Community people linked to the team.
   *Coaching's "tough game?" question.* The season ends 10-22, so this will
   likely land too late for this season and be ready for the next.
4. **Suggestions:** the nightly generator, suggestion → action-layer hand-off,
   and concept images.
5. **Work bindings:** `jira_*`, `github_*` and `website`, with the Websites and
   Jira panels folded into projects.
6. **Separate track, not part of Projects:** low-effort nutrition logging
   (photograph a meal → estimated macros → correct by voice). It ships as a
   health source that the muscle-gain project then binds to.

Insulation can't wait for any of this. It needs a deadline and a few steps,
which phase 1 provides. Until then it should go in as a home project with
`priority='high'` and a due date.

## Owner decisions (2026-10-13)

1. **Rosters are parsed and stored server-side, owner-only.** Kids' names from
   rosters become part of the owner's Community data: people he coaches, linked
   to their team. They are readable by the owner's profile alone. They are
   never household-visible even if the project later is, never shown to another
   Guardian, and excluded from dreaming (`involves_children`). Team *photos*
   still stay on the device; only the text roster is stored.
2. **Home becomes its own dashboard section.** Porch, insulation, the 20–40
   list and anything else home-related (utilities, maintenance schedules) live
   there. The overview page is labelled "Dashboard" but its internal key in
   `DashboardSection` is `'Home'` (also the icon sprite key in `icons.tsx`).
   Rename that key to `'Dashboard'` first, then add a real `'Home'` section.
   Placement in the fixed card order is the owner's call.
3. **The weekly progress photo is a card suggestion, not an initiative
   trigger.** No check-in trigger is proposed. It appears as an open suggestion
   on the project when a week passes without a `progress` photo.
4. **Work projects stay off the Dashboard.** Projects whose primary area is
   `work` never appear in the Dashboard's Projects card. They show on the Work
   section and the Projects page only.

## Plan tools (0096, 2026-10-25)

Added for the side-yard fence/awning build (HOME-SIDEYARD-2026-001), which
arrived as a versioned spec with confirmed and still-to-verify measurements, a
material takeoff, a working budget and an approval ceiling.

- `pinned_at` — "move to the front". `rank.js` puts every pinned open project
  above every unpinned one, newest pin first, with "you moved it to the front"
  as its reason. It is set by the person only; nothing learned sets it.
- `ref_code`, `revision` — the person's reference and spec version. "New
  version…" in the app bumps `revision` and writes a `decision` journal entry,
  so the history lives in the journal, not in a versions table.
- `budget_working`, `budget_ceiling`, `budget_note` — working ≤ ceiling.
- `athena_project_item` — `spec` or `material` rows, each `confirmed`,
  `pending` (to verify) or `estimate`; materials carry an optional cost range
  that the app totals against the budget.

These columns are written only when a request mentions them
(`columnsFor` in `index.js`), so every other edit keeps working on a database
without 0096. Since 0097 the chat actions cover them too (owner, 10-25).

## Execution (0097, 2026-10-25)

The owner's brief: turn Projects from tracking and ranking into finishing —
always able to say what can be done next, what's in the way, when the work
happens, what finished means, and what comes after this step. Extended in
place; nothing above changed meaning.

**One engine, derived on read.** `src/services/projects/execution.js` is pure
like `rank.js`: given the graph from `getAll()` and a `now`, it answers
`getExecutableSteps`, `getNextAction`, `getStepBlockers`,
`getBlockedStepsNeedingReview` / `getOverdueFollowUps` / `getUnblockActions`,
`getCompletionReadiness` / `getIncompleteAcceptanceCriteria` /
`getProjectCloseoutSummary`, the session helpers (`upcomingSessions`,
`getUnscheduledExecutableSteps`, `suggestWorkSession`, `getSessionPreparation`)
and, per project, `getProjectExecutionState`; `getExecutionPlan` does every
open project at once and applies the work-in-progress preference. The
snapshot (`controllers/projects.js`), Right Now and `prompt.js` all read it, so
none of them can disagree about whether a step is ready. Nothing it derives is
stored.

- **Dependencies** (`athena_project_step_dependency`). Ordinal is display
  order; only an edge makes a step wait. Both ends carry `project_id` and
  reference `(id, project_id)` on the step, so a cross-project edge can't be
  written. Self-edges and cycles are refused in `writeDependencies`. A skipped
  prerequisite holds nothing up, like a dropped project dependency. Legacy
  steps have no edges, so every open one is ready, top to bottom.
- **Executable**: todo/in progress, every prerequisite done or skipped, not
  blocked, on a project whose effective status is idea/planning/ready/active
  (waiting and blocked projects hold every step). "Active" in the brief is read
  as *open and not held* so the side yard (`planning`) has a next action; a step
  on a project that isn't active yet is flagged `startsNew`, which is what the
  preference weighs.
- **Next action** scores in-progress, due dates, fit in the free window (too big
  → `needsMultipleSessions`, never excluded), the wet-day indoor rule, and who
  does it, on top of the project's `rank.js` score. Unknown effort or place
  stops counting rather than excluding.
- **Blockers**: `waiting_on_actor`, `review_at`, `unblock_action` beside the
  existing `blocked_on`, all cleared on unblock. A due `review_at` is a
  follow-up keyed `stepUuid@reviewAt` — one per review date (`newFollowUps`
  is the dedupe for anything that tells the person); no date is "needs
  triage". Nothing resolves a blocker but a person. **There is no push for
  follow-ups**: initiative is protected, and a project follow-up trigger would
  be a new one the owner enables — proposed, not built. They surface on the
  project, in Right Now (`kind: "followup"`) and in the chat prompt.
- **Phases**: `athena_project_step.phase`, a free-text label (owner, 10-25).
  `getPhases` groups the plan by it — order of first appearance, unlabelled
  last, done/total and a date range from due dates and sessions. Deliberately
  not an entity and never a gate: two things that can each block a step is
  how plans get stuck for reasons nobody can see. A chunk with its own budget,
  season or status is a project linked with `contributes_to`, not a phase.
- **Completion**: `done_when` (one criterion per line), `done_when_confirmed`
  (by text, so rewording un-confirms), `outcome_confirmed_at`, step
  `acceptance_criteria`. Readiness is `work_remaining` → `outcome_unverified`
  → `ready_for_confirmation` → `verified_complete` (or `complete` for a legacy
  project closed without criteria). `update()` refuses to close a project
  with criteria unless `outcomeConfirmed: true`; chat can only do that through
  `close_out_project`, which is never standing.
- **Sessions** (`athena_project_work_session`): project or step, many per
  step, UTC `planned_start`. Rescheduling updates the row (same uuid). The
  same work can't overlap itself. Completing one never completes its step.
  The calendar is separate: `put_project_session_on_calendar` (Google Calendar
  provider, `action_authority`, never standing, `direct` so the app's button is
  the approval) creates the event, or deletes-then-recreates it after a
  reschedule; `calendar_start` says whether the event still matches. Rescheduling
  or deleting a session never touches the calendar.
- **Work-in-progress preference** (`athena_project_pref`, default 3 and
  prefer finishing): a `startsNew` step loses 10 points, 40 when the active
  count is at the limit; priority 5, a deadline within 14 days, `serves`
  safety, an open severe concern, or a pin exempt it. It only orders.
- **Success counts** (`metrics` in the snapshot's `execution`): active projects
  with a next action, blocked without a follow-up, oldest progress, sessions
  planned vs completed (30 days), verified completions and the median days
  from `activated_at` (first time active) to the confirmed outcome.

Compatibility: every new column is written only when the row already has it
or the request names it (`columnsFor`/`stepColumnsFor`), and the new tables
are read with a catch, so the code runs on a database without 0097. Older
clients ignore the new snapshot fields. The importer is unchanged and stays
create-only on `import_key`.
