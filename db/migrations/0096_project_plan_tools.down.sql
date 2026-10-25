DROP TABLE IF EXISTS athena_project_item;

ALTER TABLE athena_project
  DROP COLUMN ref_code,
  DROP COLUMN revision,
  DROP COLUMN pinned_at,
  DROP COLUMN budget_working,
  DROP COLUMN budget_ceiling,
  DROP COLUMN budget_note;
