DELETE FROM athena_gm_mission_step WHERE status = 'pending';
ALTER TABLE athena_gm_mission_step
  DROP COLUMN due_minutes,
  DROP COLUMN after_keys,
  DROP COLUMN phase,
  DROP COLUMN plan_key,
  MODIFY COLUMN status ENUM('waiting_parent','waiting_kids','ready','in_progress','done','stuck','declined') NOT NULL DEFAULT 'ready';
ALTER TABLE athena_gm_mission
  DROP COLUMN go_at,
  DROP COLUMN go_by_actor_id,
  DROP COLUMN supervisor_actor_id,
  DROP COLUMN phase,
  DROP COLUMN pass_criteria,
  DROP COLUMN purpose,
  DROP COLUMN plan_version,
  DROP COLUMN plan;
