-- The First Watch is over (owner, 2026-10-30). 0103 copied it in as running and
-- nothing moves a legacy row afterwards. Ended at the team's last recorded find.
UPDATE athena_gm_mission
SET status = 'completed',
    ended_at = COALESCE(ended_at, (SELECT MAX(found_at) FROM guardian_index_find WHERE mission_key = 'mission-3-first-watch'))
WHERE mission_key = 'mission-3-first-watch' AND source = 'legacy' AND status = 'running';
