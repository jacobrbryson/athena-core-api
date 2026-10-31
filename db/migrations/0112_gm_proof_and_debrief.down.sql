ALTER TABLE athena_gm_actor_capability DROP COLUMN evidence_mission_id;
DROP TABLE IF EXISTS athena_gm_weakness;
DROP TABLE IF EXISTS athena_gm_debrief;
DROP TABLE IF EXISTS athena_gm_prediction;
DROP TABLE IF EXISTS athena_gm_step_secret;
UPDATE athena_gm_mission_step SET proof_required = 'none' WHERE proof_required = 'code';
ALTER TABLE athena_gm_mission_step
  MODIFY COLUMN proof_required ENUM('none','photo','photo_set','camera_check','kid_confirm','parent_confirm') NOT NULL DEFAULT 'photo';
