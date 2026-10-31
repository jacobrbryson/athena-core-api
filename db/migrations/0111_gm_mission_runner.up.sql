-- Running a mission from its plan (docs/capabilities/guardians-missions.md,
-- owner 2026-10-31). Approve and Go are separate: approving locks the plan and
-- starts adult preparation; Go is a person saying "we're ready, start now", and
-- only then can a kid be contacted.
--
--   prep     adults are getting it ready
--   ready    prep is done, waiting for an adult to press Go
--   live     Go was pressed; the kids are in it
--   debrief  it finished; results are being read
--
-- plan and pass_criteria are the words approved, locked at approval. A change
-- is a new version and a new approval.
ALTER TABLE athena_gm_mission
  ADD COLUMN plan JSON NULL AFTER notes,
  ADD COLUMN plan_version SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER plan,
  ADD COLUMN purpose ENUM('test','add') NULL AFTER plan_version,
  ADD COLUMN pass_criteria JSON NULL AFTER purpose,
  ADD COLUMN phase ENUM('prep','ready','live','debrief') NOT NULL DEFAULT 'prep' AFTER status,
  ADD COLUMN supervisor_actor_id BIGINT UNSIGNED NULL AFTER approval_action_uuid,
  ADD COLUMN go_by_actor_id BIGINT UNSIGNED NULL AFTER supervisor_actor_id,
  ADD COLUMN go_at DATETIME NULL AFTER go_by_actor_id;

-- A planned step waits as 'pending' until the steps it follows are done.
-- plan_key names it inside its plan, after_keys lists what must finish first,
-- and due_minutes is measured from when it opens.
ALTER TABLE athena_gm_mission_step
  MODIFY COLUMN status ENUM('pending','waiting_parent','waiting_kids','ready','in_progress','done','stuck','declined') NOT NULL DEFAULT 'ready',
  ADD COLUMN plan_key VARCHAR(40) NULL AFTER mission_id,
  ADD COLUMN phase ENUM('prep','live') NOT NULL DEFAULT 'prep' AFTER plan_key,
  ADD COLUMN after_keys JSON NULL AFTER phase,
  ADD COLUMN due_minutes INT UNSIGNED NULL AFTER due_at;
