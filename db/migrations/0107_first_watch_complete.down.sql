UPDATE athena_gm_mission
SET status = 'running', ended_at = NULL
WHERE mission_key = 'mission-3-first-watch' AND source = 'legacy' AND status = 'completed';
