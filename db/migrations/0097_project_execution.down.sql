DROP TABLE IF EXISTS athena_project_pref;
DROP TABLE IF EXISTS athena_project_work_session;
DROP TABLE IF EXISTS athena_project_step_dependency;

ALTER TABLE athena_project_step
  DROP KEY idx_project_step_review,
  DROP KEY uq_project_step_in_project,
  DROP COLUMN unblock_action,
  DROP COLUMN review_at,
  DROP COLUMN waiting_on_actor,
  DROP COLUMN acceptance_criteria,
  DROP COLUMN phase;

ALTER TABLE athena_project
  DROP COLUMN activated_at,
  DROP COLUMN outcome_confirmed_at,
  DROP COLUMN done_when_confirmed,
  DROP COLUMN done_when;
