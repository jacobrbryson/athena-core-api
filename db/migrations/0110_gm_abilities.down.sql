SET @bryson := (SELECT family_id FROM family_members WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1);
SET @wolfer := (SELECT family_id FROM family_members WHERE display_name = 'Jenny Wolfer' AND role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1);

DELETE FROM athena_gm_capability WHERE family_id = @wolfer AND kind = 'skill';
DELETE FROM athena_gm_capability
WHERE cap_key IN ('web_search', 'recall_memory', 'research_studies', 'project_planning', 'set_thermostat', 'play_game', 'learn_from_results');

INSERT INTO athena_gm_capability (uuid, family_id, cap_key, kind, name, description, badge, audience)
SELECT UUID(), family_id, 'knows_morse', 'skill', 'Knows Morse', 'Can send and read Morse code.', badge, 'kids_too'
FROM athena_gm_capability WHERE cap_key = 'reads_morse'
ON DUPLICATE KEY UPDATE name = VALUES(name);
DELETE FROM athena_gm_capability WHERE cap_key IN ('reads_morse', 'sends_morse');

ALTER TABLE athena_gm_capability DROP COLUMN athena_via;
ALTER TABLE athena_gm_mission DROP COLUMN reach_rung;
DROP TABLE IF EXISTS athena_gm_capability_ability;
DROP TABLE IF EXISTS athena_gm_ability;
