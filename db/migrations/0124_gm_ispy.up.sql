-- =====================================================================
-- 0124_gm_ispy.up.sql
-- I Spy (owner, 2026-11-23): Thomas, Skylar and Athena take turns spying
-- with photos on the kids' tablets; 12 finished rounds finish the mission
-- and unlock a badge.
-- ---------------------------------------------------------------------
-- athena_gm_mission_step.proof_required gains 'game': the step is finished
-- by the game its plan names, never by a tap.
--
-- athena_gm_ispy_round: one round. spy_actor_id is whoever is spying (a kid,
-- or Athena's own actor). The photo is kept for the debrief (owner's choice)
-- as an athena_gm_photo row on the spy's step; photo_id points at it.
--   answer   — what was spied. When a kid spies it is what they typed; when
--              Athena spies it is her pick, and never leaves the server until
--              the round ends.
--   aliases  — other words that count as the same thing (Athena's rounds).
--   guesses  — JSON list of { by, text, right, at }, in order.
--   outcome  — 'guessed' (someone got it), 'taught' (Athena missed and the
--              spy told her), 'revealed' (nobody got Athena's), or NULL open.
--
-- Conventions match 0001-0123.
-- =====================================================================

ALTER TABLE athena_gm_mission_step
  MODIFY COLUMN proof_required ENUM('none','photo','photo_set','camera_check','kid_confirm','parent_confirm','code','game') NOT NULL DEFAULT 'photo';

CREATE TABLE IF NOT EXISTS athena_gm_ispy_round (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  mission_id BIGINT UNSIGNED NOT NULL,
  round_no INT NOT NULL,
  spy_actor_id BIGINT UNSIGNED NOT NULL,
  started_by_actor_id BIGINT UNSIGNED NOT NULL,
  photo_id BIGINT UNSIGNED NULL,
  clue VARCHAR(200) NOT NULL,
  answer VARCHAR(200) NOT NULL,
  aliases JSON NULL,
  hints JSON NULL,
  guesses JSON NULL,
  outcome ENUM('guessed','taught','revealed') NULL,
  solved_by_actor_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_ispy_uuid (uuid),
  UNIQUE KEY uq_gm_ispy_round (mission_id, round_no),
  KEY idx_gm_ispy_family (family_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
