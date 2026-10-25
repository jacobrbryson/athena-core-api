-- =====================================================================
-- 0096_project_plan_tools.up.sql
-- What a build project needs beyond steps (docs/architecture/projects.md).
--
-- The owner's side-yard fence/awning project (HOME-SIDEYARD-2026-001,
-- 2026-10-25) came as a versioned spec: a reference code and revision,
-- measurements some of which are confirmed and some still to verify, a
-- material takeoff, a working budget and an approval ceiling — and an
-- instruction to put it at the front of the line. None of it had a place.
--
-- pinned_at: "move to the front". Pinned projects rank above every unpinned
-- one, newest pin first; clearing it hands the order back to the arithmetic.
-- It is something the person set, never something learned.
--
-- athena_project_item: specs (a measurement or decision) and materials
-- (a takeoff line with an optional cost range), each confirmed, pending
-- verification, or an estimate.
-- =====================================================================
ALTER TABLE athena_project
  ADD COLUMN ref_code VARCHAR(48) NULL AFTER kind,
  ADD COLUMN revision VARCHAR(16) NULL AFTER ref_code,
  ADD COLUMN pinned_at DATETIME NULL AFTER priority,
  ADD COLUMN budget_working DECIMAL(10,2) NULL AFTER cost_note,
  ADD COLUMN budget_ceiling DECIMAL(10,2) NULL AFTER budget_working,
  ADD COLUMN budget_note VARCHAR(190) NULL AFTER budget_ceiling;

CREATE TABLE IF NOT EXISTS athena_project_item (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('spec','material') NOT NULL,
  ordinal INT UNSIGNED NOT NULL DEFAULT 0,
  label VARCHAR(190) NOT NULL,
  -- Free text so "13 ft × 75 in" and "5–7" both fit; unit beside it.
  value VARCHAR(64) NULL,
  unit VARCHAR(16) NULL,
  status ENUM('confirmed','pending','estimate') NOT NULL DEFAULT 'pending',
  cost_low DECIMAL(10,2) NULL,
  cost_high DECIMAL(10,2) NULL,
  note VARCHAR(255) NULL,
  confirmed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_item_uuid (uuid),
  KEY idx_project_item (project_id, kind, ordinal),
  CONSTRAINT fk_project_item_project FOREIGN KEY (project_id) REFERENCES athena_project (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
