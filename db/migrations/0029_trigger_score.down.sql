-- Reverse of 0029_trigger_score.
--
-- Drops everything Athena learned about which interruptions were wanted.
-- Triggers return to firing purely on their rules and the person's own
-- settings; nothing becomes louder than those settings allow.
ALTER TABLE athena_nudge DROP COLUMN appraised_at, DROP COLUMN appraisal;
DROP TABLE IF EXISTS athena_trigger_score;
