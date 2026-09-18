-- Reverse of 0027_athena_initiative.
--
-- Dropping athena_nudge loses the record of every time Athena spoke
-- first and how each one landed -- which is the only evidence the
-- nightly review has that her interruptions are welcome. Export it
-- before running this in production.
DROP TABLE IF EXISTS athena_trigger_mute;
DROP TABLE IF EXISTS athena_initiative_pref;
DROP TABLE IF EXISTS athena_nudge;
