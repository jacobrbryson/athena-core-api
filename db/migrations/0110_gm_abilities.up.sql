-- Athena's abilities (docs/capabilities/guardians-missions.md, owner
-- 2026-10-31). A capability is a tool she has; an ability is what she can do
-- with her tools. One capability can feed several abilities. Scores are not
-- stored: services/guardianMissions/abilities.js works them out from test
-- results, so each one can be explained.
--
-- Abilities are hers, not a family's, so they carry no family_id and links go
-- by cap_key: the same tool in two families feeds the same ability.
CREATE TABLE IF NOT EXISTS athena_gm_ability (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ability_key VARCHAR(40) NOT NULL,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(255) NOT NULL,
  seq TINYINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_ability_key (ability_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- weight: how much this capability carries the ability, 1 to 3.
CREATE TABLE IF NOT EXISTS athena_gm_capability_ability (
  cap_key VARCHAR(60) NOT NULL,
  ability_id BIGINT UNSIGNED NOT NULL,
  weight TINYINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (cap_key, ability_id),
  KEY idx_gm_capability_ability (ability_id),
  CONSTRAINT fk_gm_ca_ability FOREIGN KEY (ability_id) REFERENCES athena_gm_ability (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- How far a mission reaches. A test counts toward an ability at this rung.
-- 1 is the household; a higher rung is set when a plan is approved, never by a
-- result. Parent Test buttons have no mission and count as 1.
ALTER TABLE athena_gm_mission
  ADD COLUMN reach_rung TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER difficulty_rung;

-- For a person's skill, the capability that is Athena's way of doing the same
-- thing, so "who can read Morse" can list her beside the kids.
ALTER TABLE athena_gm_capability
  ADD COLUMN athena_via VARCHAR(60) NULL AFTER self_knowledge_id;

INSERT INTO athena_gm_ability (ability_key, name, description, seq) VALUES
  ('perception', 'Perception', 'Noticing what is happening in the world.', 1),
  ('investigation', 'Investigation', 'Finding out what is true.', 2),
  ('strategy', 'Strategy', 'Turning a goal into a plan that survives surprises.', 3),
  ('communication', 'Communication', 'Reaching the right person, the right way.', 4),
  ('coordination', 'Coordination', 'Getting people working together.', 5),
  ('action', 'Action', 'Changing something in the physical world.', 6),
  ('adaptation', 'Adaptation', 'Getting better after failing.', 7)
ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), seq = VALUES(seq);

-- What she can already do outside missions, as capabilities a mission can
-- test. Every one starts untested.
SET @bryson := (SELECT family_id FROM family_members WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1);

INSERT INTO athena_gm_capability
  (uuid, family_id, cap_key, kind, name, description, channel, locality, permission, self_knowledge_id, badge, audience)
SELECT UUID(), @bryson, c.cap_key, 'system', c.name, c.description, c.channel, c.locality, c.permission, c.sk, c.badge, 'parent_only'
FROM (
  SELECT 'web_search' cap_key, 'Search the web' name, 'Look something up and show the pages used.' description, 'Gemini with Google Search' channel, 'cloud' locality, 'free' permission, 'web-search' sk, '🔍' badge
  UNION ALL SELECT 'recall_memory', 'Recall what she knows', 'Use what she remembers about the family and their world.', 'Athena memory', 'cloud', 'free', 'memories', '🧠'
  UNION ALL SELECT 'research_studies', 'Run a small study', 'Look for a pattern in the household''s own data.', 'Research page', 'cloud', 'free', 'research', '📊'
  UNION ALL SELECT 'project_planning', 'Plan a project', 'Break a goal into steps and say what comes first.', 'Projects', 'cloud', 'free', 'projects', '📋'
  UNION ALL SELECT 'set_thermostat', 'Set a thermostat', 'Change a thermostat, with a person''s approval each time.', 'Google Nest', 'cloud', 'parent_approval', 'nest', '🌡️'
  UNION ALL SELECT 'play_game', 'Play a game by sight', 'Play from the screen and keyboard alone.', 'Local vision model', 'local', 'free', 'game-playing', '🎮'
  UNION ALL SELECT 'learn_from_results', 'Learn from a result', 'Do measurably better on a second try.', 'Mission debriefs', 'cloud', 'free', NULL, '📈'
) c
WHERE @bryson IS NOT NULL
ON DUPLICATE KEY UPDATE athena_gm_capability.name = athena_gm_capability.name;

INSERT INTO athena_gm_capability_ability (cap_key, ability_id, weight)
SELECT l.cap_key, a.id, l.weight
FROM (
  SELECT 'view_cameras' cap_key, 'perception' ability, 3 weight
  UNION ALL SELECT 'photo_proof', 'perception', 3
  UNION ALL SELECT 'scout_geography', 'perception', 3
  UNION ALL SELECT 'doorbell_camera', 'perception', 2
  UNION ALL SELECT 'morse_in_camera', 'perception', 1
  UNION ALL SELECT 'pan_tilt_camera', 'perception', 1
  UNION ALL SELECT 'phone_camera', 'perception', 1
  UNION ALL SELECT 'phone_gps', 'perception', 1
  UNION ALL SELECT 'phone_compass', 'perception', 1
  UNION ALL SELECT 'web_search', 'investigation', 3
  UNION ALL SELECT 'recall_memory', 'investigation', 2
  UNION ALL SELECT 'research_studies', 'investigation', 2
  UNION ALL SELECT 'scout_geography', 'investigation', 1
  UNION ALL SELECT 'clue_planning', 'strategy', 3
  UNION ALL SELECT 'project_planning', 'strategy', 3
  UNION ALL SELECT 'escalating_hints', 'strategy', 1
  UNION ALL SELECT 'push_notification', 'communication', 2
  UNION ALL SELECT 'text_contacts', 'communication', 2
  UNION ALL SELECT 'escalating_hints', 'communication', 2
  UNION ALL SELECT 'speak_through_camera', 'communication', 2
  UNION ALL SELECT 'email_contacts', 'communication', 1
  UNION ALL SELECT 'kids_watch_message', 'communication', 1
  UNION ALL SELECT 'morse_out_light', 'communication', 1
  UNION ALL SELECT 'walkie_coordination', 'coordination', 3
  UNION ALL SELECT 'escalating_hints', 'coordination', 1
  UNION ALL SELECT 'push_notification', 'coordination', 1
  UNION ALL SELECT 'text_contacts', 'coordination', 1
  UNION ALL SELECT 'porch_light', 'action', 2
  UNION ALL SELECT 'set_thermostat', 'action', 2
  UNION ALL SELECT 'pan_tilt_camera', 'action', 1
  UNION ALL SELECT 'morse_out_light', 'action', 1
  UNION ALL SELECT 'learn_from_results', 'adaptation', 3
  UNION ALL SELECT 'play_game', 'adaptation', 2
  UNION ALL SELECT 'reads_morse', 'communication', 2
  UNION ALL SELECT 'sends_morse', 'communication', 2
  UNION ALL SELECT 'uses_walkies', 'communication', 1
  UNION ALL SELECT 'uses_walkies', 'coordination', 2
  UNION ALL SELECT 'plays_soccer', 'coordination', 1
  UNION ALL SELECT 'uses_compass', 'investigation', 2
  UNION ALL SELECT 'mile_7min', 'action', 1
) l
JOIN athena_gm_ability a ON a.ability_key = l.ability
ON DUPLICATE KEY UPDATE weight = VALUES(weight);

-- Reading and sending Morse are different skills. Nobody holds knows_morse yet,
-- so splitting it loses nothing, and its removal cascades only to empty links.
INSERT INTO athena_gm_capability (uuid, family_id, cap_key, kind, name, description, athena_via, badge, audience)
SELECT UUID(), k.family_id, s.cap_key, 'skill', s.name, s.description, s.via, k.badge, 'kids_too'
FROM athena_gm_capability k
JOIN (
  SELECT 'reads_morse' cap_key, 'Reads Morse' name, 'Can read Morse code someone else sends.' description, 'morse_in_camera' via
  UNION ALL SELECT 'sends_morse', 'Sends Morse', 'Can send a message in Morse code.', 'morse_out_light'
) s
WHERE k.cap_key = 'knows_morse'
ON DUPLICATE KEY UPDATE name = VALUES(name);

DELETE FROM athena_gm_capability WHERE cap_key = 'knows_morse';

-- The Wolfers get the same person skills, so Lena and Livia can be tracked.
-- Household tools stay with the household that has them.
SET @wolfer := (SELECT family_id FROM family_members WHERE display_name = 'Jenny Wolfer' AND role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1);

INSERT INTO athena_gm_capability (uuid, family_id, cap_key, kind, name, description, athena_via, badge, audience)
SELECT UUID(), @wolfer, c.cap_key, 'skill', c.name, c.description, c.athena_via, c.badge, c.audience
FROM athena_gm_capability c
WHERE @wolfer IS NOT NULL AND c.family_id = @bryson AND c.kind = 'skill'
ON DUPLICATE KEY UPDATE name = VALUES(name);
