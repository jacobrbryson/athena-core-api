-- =====================================================================
-- 0097_project_execution.up.sql
-- Projects P0 execution engine (docs/architecture/projects.md, "Execution").
--
-- Projects could say what they were and in what order, not what can be done
-- next, what is holding things up and when to look again, when the work will
-- happen, or what finished means. Four additions, all additive:
--
-- 1. athena_project_step_dependency: "this step needs that one first".
--    Ordering stays display order; only these rows make a prerequisite.
--    Both ends carry project_id and reference (id, project_id) on the step,
--    so a dependency across projects cannot be written even by mistake.
--    Self-edges and cycles are refused in the service (MySQL forbids a CHECK
--    on a column that a cascading foreign key uses).
-- 2. Blocker follow-through on athena_project_step: who it waits on, when to
--    look again, and what would clear it. A review date coming due surfaces a
--    follow-up; it never resolves the blocker.
-- 3. Outcome-based completion: athena_project.done_when (one criterion per
--    line), the criteria the person has confirmed (by their text, so editing a
--    line un-confirms it), and when they confirmed the outcome. Plus
--    athena_project_step.acceptance_criteria. activated_at is the first time
--    a project went active, for "activation to verified completion".
-- 4. athena_project_work_session: time set aside to do the work. A finished
--    session never finishes its step. calendar_event_id is set only by an
--    approved calendar action, and is unique per person so one session can
--    never be two events.
-- 5. athena_project_pref: the work-in-progress recommendation preference.
--    A preference for ordering suggestions, never a limit.
-- =====================================================================

ALTER TABLE athena_project
  ADD COLUMN done_when TEXT NULL AFTER goal,
  ADD COLUMN done_when_confirmed JSON NULL AFTER done_when,
  ADD COLUMN outcome_confirmed_at DATETIME NULL AFTER completed_at,
  ADD COLUMN activated_at DATETIME NULL AFTER last_progress_at;

-- phase: an optional label that groups steps on the plan ("Concrete and
-- Foundations"). Display and conversation only — it never makes a step wait;
-- dependencies do that.
ALTER TABLE athena_project_step
  ADD COLUMN phase VARCHAR(64) NULL AFTER ordinal,
  ADD COLUMN acceptance_criteria TEXT NULL AFTER detail,
  ADD COLUMN waiting_on_actor VARCHAR(190) NULL AFTER blocked_on,
  ADD COLUMN review_at DATETIME NULL AFTER waiting_on_actor,
  ADD COLUMN unblock_action VARCHAR(190) NULL AFTER review_at,
  ADD UNIQUE KEY uq_project_step_in_project (id, project_id),
  ADD KEY idx_project_step_review (project_id, status, review_at);

CREATE TABLE IF NOT EXISTS athena_project_step_dependency (
  project_id BIGINT UNSIGNED NOT NULL,
  step_id BIGINT UNSIGNED NOT NULL,
  depends_on_step_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (step_id, depends_on_step_id),
  KEY idx_step_dependency_project (project_id),
  KEY idx_step_dependency_prereq (depends_on_step_id),
  CONSTRAINT fk_step_dependency_step FOREIGN KEY (step_id, project_id)
    REFERENCES athena_project_step (id, project_id) ON DELETE CASCADE,
  CONSTRAINT fk_step_dependency_prereq FOREIGN KEY (depends_on_step_id, project_id)
    REFERENCES athena_project_step (id, project_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_project_work_session (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  step_id BIGINT UNSIGNED NULL,
  -- UTC. Rescheduling changes these, never the row's identity.
  planned_start DATETIME NOT NULL,
  planned_duration_minutes INT UNSIGNED NOT NULL,
  actual_duration_minutes INT UNSIGNED NULL,
  status ENUM('planned','in_progress','completed','skipped','cancelled') NOT NULL DEFAULT 'planned',
  -- Whether the person said the session moved the work forward. NULL = not asked yet.
  made_progress TINYINT(1) NULL,
  calendar_event_id VARCHAR(255) NULL,
  -- The start the calendar event was written with; differs from planned_start
  -- once the session is rescheduled, until an approved action moves the event.
  calendar_start DATETIME NULL,
  notes TEXT NULL,
  completed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_work_session_uuid (uuid),
  UNIQUE KEY uq_work_session_calendar (profile_id, calendar_event_id),
  KEY idx_work_session_upcoming (profile_id, status, planned_start),
  KEY idx_work_session_project (project_id, planned_start),
  CONSTRAINT fk_work_session_project FOREIGN KEY (project_id) REFERENCES athena_project (id) ON DELETE CASCADE,
  CONSTRAINT fk_work_session_step FOREIGN KEY (step_id) REFERENCES athena_project_step (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_project_pref (
  profile_id BIGINT NOT NULL,
  -- About how many active personal projects to keep moving at once (2–3 by default).
  focus_limit TINYINT UNSIGNED NOT NULL DEFAULT 3,
  -- Prefer a step on something already active over starting something new.
  prefer_finishing TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A project that is already active started at some point before now; the
-- best honest answer for those is "unknown", so activated_at stays NULL.
