-- 0125_gm_mission_planned_for.up.sql
-- When the grown-ups plan to press Go (owner, 11-24). Only what the kids'
-- countdown shows: it starts nothing, and Go is still a person's click.
ALTER TABLE athena_gm_mission
  ADD COLUMN planned_for DATETIME NULL AFTER go_at;
