-- 0124_gm_ispy.down.sql
DROP TABLE IF EXISTS athena_gm_ispy_round;
UPDATE athena_gm_mission_step SET proof_required = 'none' WHERE proof_required = 'game';
ALTER TABLE athena_gm_mission_step
  MODIFY COLUMN proof_required ENUM('none','photo','photo_set','camera_check','kid_confirm','parent_confirm','code') NOT NULL DEFAULT 'photo';
