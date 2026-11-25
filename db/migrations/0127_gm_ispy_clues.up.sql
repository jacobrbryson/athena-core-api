-- =====================================================================
-- 0127_gm_ispy_clues.up.sql
-- I Spy clue cards (owner, 2026-11-24): the kids and Athena can ask each other
-- for a clue, answered from a fixed list ("In the car", "Outside", …) or
-- "None". The list lives in code (ispy.js CLUES); a round keeps what was given.
-- ---------------------------------------------------------------------
--   clues          — JSON list of { key, by, at } in order; key is a CLUES key
--                    or 'none'. On a kid's round Athena asks and the spy
--                    answers; on Athena's round a kid asks and she answers.
--                    Every clue is put into her later prompts for the round.
--   clue_asked_by  — actor id of whoever is waiting for a clue right now
--                    (Athena, on a kid's round), or NULL.
--
-- Conventions match 0001-0126.
-- =====================================================================

ALTER TABLE athena_gm_ispy_round
  ADD COLUMN clues JSON NULL AFTER hints,
  ADD COLUMN clue_asked_by BIGINT UNSIGNED NULL AFTER clues;
