-- =====================================================================
-- 0123_person_grade.up.sql
-- A child's grade on their person page, editable, and moving up by itself
-- each school year (owner, 2026-11-23).
-- ---------------------------------------------------------------------
-- athena_person gains:
--   grade       — the grade as it was set ("pre-k", "kindergarten", "1".."12").
--   grade_year  — the school year it was set in, by the year it started
--                 (Aug 2026 – Jul 2027 is 2026). The page shows the grade
--                 advanced by however many school years have begun since,
--                 so nothing has to run on August 1st to move it.
--
-- Conventions match 0001-0122.
-- =====================================================================

ALTER TABLE athena_person
  ADD COLUMN grade      VARCHAR(20) NULL AFTER relation,
  ADD COLUMN grade_year SMALLINT    NULL AFTER grade;
