-- =====================================================================
-- 0103_guardian_missions.up.sql
-- Guardians dashboard: Athena's capabilities, the missions that test them,
-- and everything she learns from running them (Companion -> Guardians).
--
-- The capability table is the source of truth; a mission is a test case that
-- updates it. Every step a mission sends is self-contained (what, where, by
-- when, what proof) and is not done until its proof arrives. Every stage of a
-- step that can fail on its own writes its own test result, so the track
-- record shows WHICH part is shaky ("porch light: 12 tests, 11 passed").
--
-- Tables are prefixed athena_gm_ ("Guardian missions") because "guardian",
-- "mission" and "capability" are all taken: guardian_* is the kids' sign-in,
-- athena_guard_* the nightly Guardian Engine, mission_contribution and
-- guardian_mission_state the Guardians app's own missions, and
-- docs/capabilities/ is Athena's self-knowledge catalog. A capability row
-- names its catalog file in `self_knowledge_id` instead of duplicating it.
--
-- Every row carries `audience` (parent_only | kids_too) so a kid view can be
-- added later by filtering. Everything is scoped by family_id.
--
-- The old Guardians-app missions are absorbed as history (source 'legacy',
-- legacy_ref = their id). Their runtime is untouched: the Guardians app keeps
-- reading missions.json and config/missions.js. Clue cards are copied by id
-- and title only - codes and record text stay in config/missions.js.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_gm_actor (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  actor_key VARCHAR(40) NOT NULL,
  kind ENUM('assistant','parent','kid','guest') NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  profile_id BIGINT NULL,
  child_profile_id BIGINT NULL,
  -- Per-recipient mute: Athena does not send this person asks while set.
  -- Asks are held, never dropped; they go out once the mute is lifted.
  muted TINYINT(1) NOT NULL DEFAULT 0,
  muted_until DATETIME NULL,
  audience ENUM('parent_only','kids_too') NOT NULL DEFAULT 'kids_too',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_actor_uuid (uuid),
  UNIQUE KEY uq_gm_actor_key (family_id, actor_key),
  KEY idx_gm_actor_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_gm_capability (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  cap_key VARCHAR(60) NOT NULL,
  -- 'system' is something Athena does through hardware or a service;
  -- 'skill' is something a person can do (knows Morse, runs a 7-minute mile).
  kind ENUM('system','skill') NOT NULL DEFAULT 'system',
  name VARCHAR(120) NOT NULL,
  description TEXT NULL,
  channel VARCHAR(120) NULL,
  locality ENUM('local','cloud','hybrid') NULL,
  permission ENUM('free','parent_approval') NOT NULL DEFAULT 'free',
  -- Mode-locked: usable only while a mission that lists it is running
  -- (lights, speaking through cameras, messaging the kids' devices).
  mission_only TINYINT(1) NOT NULL DEFAULT 0,
  -- House controls the kill switch cuts (lights, cameras).
  house_control TINYINT(1) NOT NULL DEFAULT 0,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  status ENUM('untested','working','flaky','broken') NOT NULL DEFAULT 'untested',
  badge VARCHAR(16) NULL,
  hardware VARCHAR(160) NULL,
  self_knowledge_id VARCHAR(60) NULL,
  last_tested_at DATETIME NULL,
  audience ENUM('parent_only','kids_too') NOT NULL DEFAULT 'parent_only',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_capability_uuid (uuid),
  UNIQUE KEY uq_gm_capability_key (family_id, cap_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_gm_actor_capability (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id BIGINT UNSIGNED NOT NULL,
  capability_id BIGINT UNSIGNED NOT NULL,
  level ENUM('untested','learning','reliable') NOT NULL DEFAULT 'untested',
  source ENUM('mission','parent_reported') NOT NULL DEFAULT 'parent_reported',
  last_tested_at DATETIME NULL,
  notes VARCHAR(500) NULL,
  audience ENUM('parent_only','kids_too') NOT NULL DEFAULT 'kids_too',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_actor_capability (actor_id, capability_id),
  CONSTRAINT fk_gm_ac_actor FOREIGN KEY (actor_id) REFERENCES athena_gm_actor (id) ON DELETE CASCADE,
  CONSTRAINT fk_gm_ac_capability FOREIGN KEY (capability_id) REFERENCES athena_gm_capability (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_gm_mission (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  mission_key VARCHAR(80) NOT NULL,
  title VARCHAR(160) NOT NULL,
  goal TEXT NULL,
  -- 1 easy, 2 medium, 3 hard, 4 later. Each rung gives Athena fewer resources.
  difficulty_rung TINYINT UNSIGNED NOT NULL DEFAULT 1,
  priority ENUM('normal','high') NOT NULL DEFAULT 'normal',
  status ENUM('proposed','approved','running','paused','completed','stopped','declined','archived') NOT NULL DEFAULT 'proposed',
  -- One approval of the plan; then she runs it. Anything that spends money or
  -- contacts outsiders still asks per call through the action layer.
  approval_state ENUM('unapproved','approved','revoked') NOT NULL DEFAULT 'unapproved',
  approved_by_profile_id BIGINT NULL,
  approved_at DATETIME NULL,
  approval_action_uuid CHAR(36) NULL,
  created_by_actor_id BIGINT UNSIGNED NULL,
  source ENUM('athena','seed','legacy','parent') NOT NULL DEFAULT 'athena',
  legacy_ref VARCHAR(80) NULL,
  adventure_key VARCHAR(60) NULL,
  notes TEXT NULL,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  stopped_by_actor_id BIGINT UNSIGNED NULL,
  stop_reason VARCHAR(255) NULL,
  audience ENUM('parent_only','kids_too') NOT NULL DEFAULT 'parent_only',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_mission_uuid (uuid),
  UNIQUE KEY uq_gm_mission_key (family_id, mission_key),
  KEY idx_gm_mission_status (family_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Least privilege: the capabilities a mission may touch, and nothing else.
CREATE TABLE IF NOT EXISTS athena_gm_mission_capability (
  mission_id BIGINT UNSIGNED NOT NULL,
  capability_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (mission_id, capability_id),
  CONSTRAINT fk_gm_mc_mission FOREIGN KEY (mission_id) REFERENCES athena_gm_mission (id) ON DELETE CASCADE,
  CONSTRAINT fk_gm_mc_capability FOREIGN KEY (capability_id) REFERENCES athena_gm_capability (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_gm_location (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  name VARCHAR(160) NOT NULL,
  lat DECIMAL(10,7) NULL,
  lng DECIMAL(10,7) NULL,
  accuracy_m DECIMAL(7,1) NULL,
  -- Approximate: a phone compass is good to roughly 10-20 degrees and drifts near metal.
  heading_deg DECIMAL(5,1) NULL,
  photo_refs JSON NULL,
  description TEXT NULL,
  hiding_potential TEXT NULL,
  difficulty TINYINT UNSIGNED NULL,
  triangulated JSON NULL,
  last_verified_at DATETIME NULL,
  verified_by_actor_id BIGINT UNSIGNED NULL,
  source_step_id BIGINT UNSIGNED NULL,
  audience ENUM('parent_only','kids_too') NOT NULL DEFAULT 'parent_only',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_location_uuid (uuid),
  KEY idx_gm_location_family (family_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_gm_mission_step (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  mission_id BIGINT UNSIGNED NOT NULL,
  seq SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  assigned_actor_id BIGINT UNSIGNED NULL,
  capability_id BIGINT UNSIGNED NULL,
  -- Self-contained: what, where, by when, and what proof - readable on its own.
  instruction TEXT NOT NULL,
  place VARCHAR(255) NULL,
  proof_required ENUM('none','photo','photo_set','camera_check','kid_confirm','parent_confirm') NOT NULL DEFAULT 'photo',
  proof JSON NULL,
  status ENUM('waiting_parent','waiting_kids','ready','in_progress','done','stuck','declined') NOT NULL DEFAULT 'ready',
  due_at DATETIME NULL,
  sent_at DATETIME NULL,
  nudge_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_nudged_at DATETIME NULL,
  -- Asks that can go out together share a batch key.
  batch_key VARCHAR(60) NULL,
  -- Spends money or contacts an outsider: the action layer asks each call.
  needs_reapproval TINYINT(1) NOT NULL DEFAULT 0,
  action_uuid CHAR(36) NULL,
  location_id BIGINT UNSIGNED NULL,
  result_note TEXT NULL,
  completed_at DATETIME NULL,
  audience ENUM('parent_only','kids_too') NOT NULL DEFAULT 'parent_only',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_step_uuid (uuid),
  KEY idx_gm_step_mission (mission_id, seq),
  KEY idx_gm_step_status (status, due_at),
  CONSTRAINT fk_gm_step_mission FOREIGN KEY (mission_id) REFERENCES athena_gm_mission (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A person's answer to an ask: done, "can't right now", pause, stop, or text.
-- Declining is a normal outcome, never a failure. Athena learns from these to
-- batch and time her asks - never to drop one.
CREATE TABLE IF NOT EXISTS athena_gm_step_reply (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  step_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  reply ENUM('done','cant_now','pause','stop','text') NOT NULL,
  text VARCHAR(500) NULL,
  via ENUM('push','sms','app','voice') NOT NULL DEFAULT 'app',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_gm_reply_step (step_id),
  KEY idx_gm_reply_actor (actor_id, reply, created_at),
  CONSTRAINT fk_gm_reply_step FOREIGN KEY (step_id) REFERENCES athena_gm_mission_step (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One photo of a scouting set (stand at one spot: north, east, south, west).
-- Sensor readings are recorded on the phone at capture time.
CREATE TABLE IF NOT EXISTS athena_gm_photo (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  step_id BIGINT UNSIGNED NULL,
  set_uuid CHAR(36) NOT NULL,
  direction ENUM('N','E','S','W','other') NOT NULL DEFAULT 'other',
  object_path VARCHAR(255) NULL,
  content_type VARCHAR(40) NULL,
  bytes INT UNSIGNED NULL,
  lat DECIMAL(10,7) NULL,
  lng DECIMAL(10,7) NULL,
  accuracy_m DECIMAL(7,1) NULL,
  heading_deg DECIMAL(5,1) NULL,
  pitch_deg DECIMAL(5,1) NULL,
  captured_at DATETIME NULL,
  uploaded_at DATETIME NULL,
  actor_id BIGINT UNSIGNED NULL,
  audience ENUM('parent_only','kids_too') NOT NULL DEFAULT 'parent_only',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_photo_uuid (uuid),
  UNIQUE KEY uq_gm_photo_set_dir (set_uuid, direction, captured_at),
  KEY idx_gm_photo_step (step_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_gm_test_result (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  capability_id BIGINT UNSIGNED NOT NULL,
  step_id BIGINT UNSIGNED NULL,
  -- Which part of the capability this measured (push_delivered, capture,
  -- sensors, upload, analysis, verification, command ...).
  stage VARCHAR(40) NOT NULL DEFAULT 'run',
  passed TINYINT(1) NOT NULL,
  latency_ms INT UNSIGNED NULL,
  notes VARCHAR(500) NULL,
  actor_id BIGINT UNSIGNED NULL,
  audience ENUM('parent_only','kids_too') NOT NULL DEFAULT 'parent_only',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_gm_test_capability (capability_id, created_at),
  KEY idx_gm_test_step (step_id),
  CONSTRAINT fk_gm_test_capability FOREIGN KEY (capability_id) REFERENCES athena_gm_capability (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Everything Athena does in the missions system, append-only.
CREATE TABLE IF NOT EXISTS athena_gm_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  mission_id BIGINT UNSIGNED NULL,
  step_id BIGINT UNSIGNED NULL,
  capability_id BIGINT UNSIGNED NULL,
  verb VARCHAR(40) NOT NULL,
  outcome ENUM('ok','refused','failed','held') NOT NULL DEFAULT 'ok',
  detail JSON NULL,
  audience ENUM('parent_only','kids_too') NOT NULL DEFAULT 'parent_only',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_gm_log_family (family_id, created_at),
  KEY idx_gm_log_mission (mission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The household's controls. Master pause holds asks (never drops them);
-- the kill switch cuts Athena's control of lights and cameras.
CREATE TABLE IF NOT EXISTS athena_gm_control (
  family_id BIGINT NOT NULL,
  mode ENUM('running','quiet_until','paused') NOT NULL DEFAULT 'running',
  quiet_until DATETIME NULL,
  kill_switch TINYINT(1) NOT NULL DEFAULT 0,
  kill_switch_at DATETIME NULL,
  monthly_budget DECIMAL(10,2) NULL,
  stop_word VARCHAR(40) NULL,
  updated_by_profile_id BIGINT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (family_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mystery and clue tracker (placeholder). Title only; never the code or text.
CREATE TABLE IF NOT EXISTS athena_gm_clue (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  mission_id BIGINT UNSIGNED NULL,
  seq SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  legacy_ref VARCHAR(20) NULL,
  title VARCHAR(160) NOT NULL,
  act TINYINT UNSIGNED NULL,
  kind VARCHAR(30) NULL,
  status ENUM('unplaced','hidden','found') NOT NULL DEFAULT 'unplaced',
  location_id BIGINT UNSIGNED NULL,
  audience ENUM('parent_only','kids_too') NOT NULL DEFAULT 'parent_only',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_clue_uuid (uuid),
  UNIQUE KEY uq_gm_clue_ref (family_id, mission_id, legacy_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
-- Seed: the owner's family (the 'owner' row in family_members).
-- =====================================================================
SET @fam := (SELECT family_id FROM family_members WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1);
SET @owner := (SELECT profile_id FROM family_members WHERE role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1);

INSERT INTO athena_gm_control (family_id) SELECT @fam FROM DUAL WHERE @fam IS NOT NULL
ON DUPLICATE KEY UPDATE family_id = family_id;

INSERT INTO athena_gm_actor (uuid, family_id, actor_key, kind, display_name, profile_id, child_profile_id, audience)
SELECT UUID(), @fam, 'athena', 'assistant', 'Athena', NULL, NULL, 'kids_too' FROM DUAL WHERE @fam IS NOT NULL
ON DUPLICATE KEY UPDATE display_name = display_name;
INSERT INTO athena_gm_actor (uuid, family_id, actor_key, kind, display_name, profile_id, child_profile_id, audience)
SELECT UUID(), @fam, 'ross', 'parent', 'Ross', @owner, NULL, 'kids_too' FROM DUAL WHERE @fam IS NOT NULL
ON DUPLICATE KEY UPDATE profile_id = VALUES(profile_id);
INSERT INTO athena_gm_actor (uuid, family_id, actor_key, kind, display_name, profile_id, child_profile_id, audience)
SELECT UUID(), @fam, LOWER(SUBSTRING_INDEX(cp.display_name, ' ', 1)), 'kid', SUBSTRING_INDEX(cp.display_name, ' ', 1), cp.profile_id, cp.id, 'kids_too'
FROM child_profiles cp
WHERE cp.family_id = @fam AND cp.deleted_at IS NULL AND cp.status = 'active'
  AND SUBSTRING_INDEX(cp.display_name, ' ', 1) IN ('Thomas', 'Skylar')
ON DUPLICATE KEY UPDATE profile_id = VALUES(profile_id), child_profile_id = VALUES(child_profile_id);

-- Capabilities. Every one starts untested. Re-running never resets a status,
-- a toggle or a test date the household has since changed.
INSERT INTO athena_gm_capability
  (uuid, family_id, cap_key, kind, name, description, channel, locality, permission, mission_only, house_control, hardware, self_knowledge_id, badge, audience)
SELECT UUID(), @fam, c.cap_key, c.kind, c.name, c.description, c.channel, c.locality, c.permission, c.mission_only, c.house_control, c.hardware, c.sk, c.badge, c.audience
FROM (
  SELECT 'scout_geography' cap_key, 'system' kind, 'Scout geography' name, 'Ask someone to stand at a spot and photograph north, east, south and west; record GPS and compass, then describe the place, what could be hidden there and how hard it is.' description, 'Push → phone camera → upload → Gemini vision' channel, 'hybrid' locality, 'free' permission, 0 mission_only, 0 house_control, 'Phone camera, GPS, compass' hardware, NULL sk, '🧭' badge, 'parent_only' audience
  UNION ALL SELECT 'text_contacts', 'system', 'Text approved contacts', 'Send a text message to a contact the household has approved.', 'Twilio SMS', 'cloud', 'free', 0, 0, NULL, 'text-messages', '💬', 'parent_only'
  UNION ALL SELECT 'email_contacts', 'system', 'Email approved contacts', 'Send an email to a contact the household has approved.', 'Gmail', 'cloud', 'free', 0, 0, NULL, 'gmail', '✉️', 'parent_only'
  UNION ALL SELECT 'push_notification', 'system', 'Push notification', 'Send a push notification with action buttons to a person''s phone. Carries the mission step it belongs to.', 'FCM (Android app)', 'cloud', 'free', 0, 0, 'Phones', NULL, '🔔', 'parent_only'
  UNION ALL SELECT 'photo_proof', 'system', 'Receive photo proof', 'Accept a photo as proof a step was done and check it shows what was asked.', 'Upload → Gemini vision', 'hybrid', 'free', 0, 0, 'Phone camera', NULL, '📸', 'parent_only'
  UNION ALL SELECT 'view_cameras', 'system', 'View cameras', 'Take a fresh look through a Eufy camera.', 'Eufy bridge (home PC, Tailscale)', 'hybrid', 'free', 0, 1, 'Eufy SoloCam E30 ×2', 'eufy-security', '👁️', 'parent_only'
  UNION ALL SELECT 'pan_tilt_camera', 'system', 'Pan/tilt camera', 'Point a SoloCam E30 (360° pan, 70° tilt).', 'Eufy bridge', 'hybrid', 'free', 1, 1, 'Eufy SoloCam E30', NULL, '🎥', 'parent_only'
  UNION ALL SELECT 'speak_through_camera', 'system', 'Speak through camera', 'Talk through a camera''s two-way audio.', 'Eufy bridge', 'hybrid', 'parent_approval', 1, 1, 'Eufy SoloCam E30, doorbell', NULL, '🗣️', 'parent_only'
  UNION ALL SELECT 'doorbell_camera', 'system', 'Doorbell camera (Guardian Gate)', 'See what the kids show the doorbell camera under the porch lights.', 'Eufy bridge', 'hybrid', 'free', 0, 1, 'Eufy doorbell', NULL, '🚪', 'parent_only'
  UNION ALL SELECT 'porch_light', 'system', 'Control porch light', 'Turn the front porch lights on and off.', 'TinyTuya on the home PC (local key)', 'local', 'free', 1, 1, 'MOES Wi-Fi toggle switch (Tuya)', NULL, '💡', 'parent_only'
  UNION ALL SELECT 'morse_out_light', 'system', 'Morse out (light)', 'Blink a short message in slow Morse on the porch light (about 1 s dot, 3 s dash).', 'Porch light', 'local', 'free', 1, 1, 'MOES switch', NULL, '📡', 'parent_only'
  UNION ALL SELECT 'morse_in_camera', 'system', 'Morse in (camera)', 'Read Morse a kid flashes at a camera.', 'Eufy bridge clip → vision', 'hybrid', 'free', 0, 1, 'Eufy cameras', NULL, '🔦', 'parent_only'
  UNION ALL SELECT 'walkie_coordination', 'system', 'Walkie-talkie coordination', 'Coordinate kids over the two Motorola walkie-talkies (through a person relaying for now).', 'People relay', 'local', 'free', 0, 0, 'Motorola long-range walkie-talkies ×2', NULL, '📻', 'parent_only'
  UNION ALL SELECT 'clue_planning', 'system', 'Hide-and-find clue planning', 'Plan where clues go using scouted locations and who can do what.', 'Gemini', 'cloud', 'free', 0, 0, NULL, NULL, '🗺️', 'parent_only'
  UNION ALL SELECT 'escalating_hints', 'system', 'Escalating hints', 'Give hints that get more direct based on what the kids report seeing.', 'Gemini', 'cloud', 'free', 0, 0, NULL, NULL, '🧩', 'parent_only'
  UNION ALL SELECT 'phone_camera', 'system', 'Phone camera', 'Open the phone camera straight from a notification.', 'Android app', 'local', 'free', 0, 0, 'Phone', NULL, '📷', 'parent_only'
  UNION ALL SELECT 'phone_gps', 'system', 'Phone GPS', 'Record where the phone is when a photo is taken.', 'Android app', 'local', 'free', 0, 0, 'Phone', 'location-context', '📍', 'parent_only'
  UNION ALL SELECT 'phone_compass', 'system', 'Phone compass', 'Record which way the phone faced (approximate, ±10-20°, drifts near metal).', 'Android app', 'local', 'free', 0, 0, 'Phone', NULL, '🧭', 'parent_only'
  UNION ALL SELECT 'kids_watch_message', 'system', 'Message the kids'' watches', 'Send a short message to Thomas''s or Skylar''s watch.', 'Unknown yet', 'cloud', 'free', 1, 0, 'Kids'' watches', NULL, '⌚', 'parent_only'
  UNION ALL SELECT 'knows_morse', 'skill', 'Knows Morse', 'Can send and read Morse code.', NULL, NULL, 'free', 0, 0, NULL, NULL, '📡', 'kids_too'
  UNION ALL SELECT 'uses_walkies', 'skill', 'Uses walkie-talkies', 'Can use a walkie-talkie properly (channel, push to talk, over).', NULL, NULL, 'free', 0, 0, NULL, NULL, '📻', 'kids_too'
  UNION ALL SELECT 'mile_7min', 'skill', 'Runs a mile in 7 minutes', 'Has run a mile in 7 minutes or less.', NULL, NULL, 'free', 0, 0, NULL, NULL, '🏃', 'kids_too'
  UNION ALL SELECT 'plays_soccer', 'skill', 'Plays soccer', 'Plays soccer.', NULL, NULL, 'free', 0, 0, NULL, NULL, '⚽', 'kids_too'
  UNION ALL SELECT 'uses_compass', 'skill', 'Uses a compass', 'Can find a bearing with a compass.', NULL, NULL, 'free', 0, 0, NULL, NULL, '🧭', 'kids_too'
) c
WHERE @fam IS NOT NULL
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- Mission ideas Athena may propose. None runs without the owner's approval.
INSERT INTO athena_gm_mission (uuid, family_id, mission_key, title, goal, difficulty_rung, priority, status, source, audience, created_by_actor_id)
SELECT UUID(), @fam, m.k, m.t, m.g, m.r, m.p, 'proposed', 'seed', m.a, (SELECT id FROM athena_gm_actor WHERE family_id = @fam AND actor_key = 'athena')
FROM (
  SELECT 'scout-the-yard' k, 'Scout the yard' t, 'First test of scouting: one spot, four photos (N, E, S, W), Athena writes the location entry, then someone walks there and confirms it matches.' g, 1 r, 'normal' p, 'parent_only' a
  UNION ALL SELECT 'blacklight-compass-hunt', 'Black light + compass hunt', 'After dark, follow compass bearings to marks only a black light shows.', 1, 'normal', 'kids_too'
  UNION ALL SELECT 'whos-talking', 'Who''s talking?', 'Athena learns to tell family voices apart; kids test her.', 1, 'normal', 'kids_too'
  UNION ALL SELECT 'creature-census', 'Creature census', 'Kids introduce Athena to family and friends; she saves their corrections.', 1, 'normal', 'kids_too'
  UNION ALL SELECT 'hidden-card-hunt', 'Hidden card hunt', 'Find a hidden card with hints that escalate based on what the kids report seeing.', 1, 'normal', 'kids_too'
  UNION ALL SELECT 'athena-is-down', '"Athena is down" drills', 'Cloud cut, power cut, then fully dark with a recovery card and walkie-talkies.', 2, 'normal', 'kids_too'
  UNION ALL SELECT 'blackout-drill', 'Blackout drill (local only)', 'Run on local MySQL, Ollama and offline Wikipedia with the internet off.', 2, 'normal', 'parent_only'
  UNION ALL SELECT 'bedroom-display-build', 'Bedroom text display build', 'Build a text display for a bedroom with Athena coaching.', 2, 'normal', 'kids_too'
  UNION ALL SELECT 'weather-machine-build', 'Weather machine build', 'Build a weather machine with Athena coaching.', 2, 'normal', 'kids_too'
  UNION ALL SELECT 'lost-puppy-hunt', 'Lost puppy doll hunt', 'Athena coordinates the kids by text and walkie-talkie to find a hidden puppy doll.', 2, 'normal', 'kids_too'
  UNION ALL SELECT 'guardian-signal-lamp', 'Guardian signal lamp', 'A signal lamp in each kid''s room Athena can light during missions.', 3, 'high', 'kids_too'
  UNION ALL SELECT 'morse-by-lamp', 'Morse by lamp', 'Exchange Morse messages by lamp.', 3, 'normal', 'kids_too'
  UNION ALL SELECT 'rc-camera-car', 'RC car with camera', 'Build an RC car with a camera, with Athena coaching.', 3, 'normal', 'kids_too'
  UNION ALL SELECT 'guardian-gate', 'Guardian Gate', 'Kids show the doorbell camera something; Athena answers in Morse on the porch light or by voice.', 2, 'normal', 'kids_too'
  UNION ALL SELECT 'vendor-calls', 'Vendor calls', 'Dry run with Ross playing the vendor first; top rung is three real calls in a row.', 4, 'normal', 'parent_only'
  UNION ALL SELECT 'puppy-hunt-drone', 'Puppy hunt: drone rung', 'The puppy hunt with a drone.', 4, 'normal', 'kids_too'
  UNION ALL SELECT 'game-clue-unlocks', 'Palworld / Minecraft clue unlocks', 'Clues that unlock things in Palworld or Minecraft.', 4, 'normal', 'kids_too'
  UNION ALL SELECT 'chores-coins', 'Family Chores coins for missions', 'Connect Family Chores coins to missions.', 4, 'normal', 'parent_only'
) m
WHERE @fam IS NOT NULL
ON DUPLICATE KEY UPDATE title = title;

-- The old Guardians-app missions, as history. The Guardians app still runs them.
INSERT INTO athena_gm_mission (uuid, family_id, mission_key, title, goal, difficulty_rung, status, approval_state, source, legacy_ref, adventure_key, audience, notes)
SELECT UUID(), @fam, m.k, m.t, m.g, 1, m.s, 'approved', 'legacy', m.k, m.adv, 'kids_too', 'Runs in the Guardians app (missions.json / config/missions.js). Imported as history.'
FROM (
  SELECT 'mission-0-check-in' k, 'Gather the Guardians' t, 'Get at least one Guardian from every family to check in with Athena.' g, 'completed' s, 'lake_norman_guardians' adv
  UNION ALL SELECT 'mission-1-ratatouille-trail', 'The Trail to Ratatouille', 'Ten logo-marked clue cards hidden around the lake house; each key unlocks the next trail leg.', 'completed', 'rescue_ratatouille'
  UNION ALL SELECT 'mission-2-convergence', 'Decryption (Convergence)', 'Each family decrypts its quarter of a torn map; the gathering place appears when all four report.', 'completed', 'lake_norman_guardians'
  UNION ALL SELECT 'mission-2-portico', 'The Portico Signal', 'A Guardian-marked field signal was recovered. Investigate it and report discoveries to Athena.', 'completed', 'lake_norman_guardians'
  UNION ALL SELECT 'mission-3-first-watch', 'The First Watch', 'Index cards from 1963 are scattered across the high ground. Find them and read Athena the code on each one.', 'running', 'lake_norman_guardians'
) m
WHERE @fam IS NOT NULL
ON DUPLICATE KEY UPDATE legacy_ref = VALUES(legacy_ref);

-- What each mission exercises (least privilege).
INSERT IGNORE INTO athena_gm_mission_capability (mission_id, capability_id)
SELECT mi.id, ca.id
FROM (
  SELECT 'scout-the-yard' k, 'scout_geography' c UNION ALL SELECT 'scout-the-yard', 'push_notification' UNION ALL SELECT 'scout-the-yard', 'phone_camera'
  UNION ALL SELECT 'scout-the-yard', 'phone_gps' UNION ALL SELECT 'scout-the-yard', 'phone_compass' UNION ALL SELECT 'scout-the-yard', 'photo_proof'
  UNION ALL SELECT 'blacklight-compass-hunt', 'push_notification' UNION ALL SELECT 'blacklight-compass-hunt', 'clue_planning' UNION ALL SELECT 'blacklight-compass-hunt', 'photo_proof'
  UNION ALL SELECT 'whos-talking', 'push_notification'
  UNION ALL SELECT 'creature-census', 'photo_proof'
  UNION ALL SELECT 'hidden-card-hunt', 'clue_planning' UNION ALL SELECT 'hidden-card-hunt', 'escalating_hints' UNION ALL SELECT 'hidden-card-hunt', 'push_notification' UNION ALL SELECT 'hidden-card-hunt', 'photo_proof'
  UNION ALL SELECT 'athena-is-down', 'walkie_coordination' UNION ALL SELECT 'athena-is-down', 'text_contacts'
  UNION ALL SELECT 'blackout-drill', 'porch_light'
  UNION ALL SELECT 'lost-puppy-hunt', 'text_contacts' UNION ALL SELECT 'lost-puppy-hunt', 'walkie_coordination' UNION ALL SELECT 'lost-puppy-hunt', 'escalating_hints' UNION ALL SELECT 'lost-puppy-hunt', 'view_cameras'
  UNION ALL SELECT 'guardian-gate', 'doorbell_camera' UNION ALL SELECT 'guardian-gate', 'porch_light' UNION ALL SELECT 'guardian-gate', 'morse_out_light' UNION ALL SELECT 'guardian-gate', 'speak_through_camera'
  UNION ALL SELECT 'morse-by-lamp', 'morse_out_light' UNION ALL SELECT 'morse-by-lamp', 'morse_in_camera'
  UNION ALL SELECT 'vendor-calls', 'text_contacts' UNION ALL SELECT 'vendor-calls', 'email_contacts'
  UNION ALL SELECT 'mission-1-ratatouille-trail', 'clue_planning' UNION ALL SELECT 'mission-3-first-watch', 'clue_planning' UNION ALL SELECT 'mission-3-first-watch', 'escalating_hints'
) x
JOIN athena_gm_mission mi ON mi.family_id = @fam AND mi.mission_key = x.k
JOIN athena_gm_capability ca ON ca.family_id = @fam AND ca.cap_key = x.c;

-- Clue cards of The First Watch, for the (placeholder) mystery tracker.
SET @m3 := (SELECT id FROM athena_gm_mission WHERE family_id = @fam AND mission_key = 'mission-3-first-watch');
INSERT IGNORE INTO athena_gm_clue (uuid, family_id, mission_id, seq, legacy_ref, title, act, kind) VALUES
  (UUID(), @fam, @m3, 1, 'F-01', 'Beam''s Mill — ledger line', 1, 'ledger'),
  (UUID(), @fam, @m3, 2, 'F-02', 'Nell''s journal — June 1963', 1, 'journal'),
  (UUID(), @fam, @m3, 3, 'F-03', 'Photograph — seven on the mill wall', 1, 'photograph'),
  (UUID(), @fam, @m3, 4, 'F-04', 'The lantern mark', 1, 'symbol'),
  (UUID(), @fam, @m3, 5, 'F-05', 'Duke Power survey stake 40-C', 1, 'survey'),
  (UUID(), @fam, @m3, 6, 'F-06', 'Nell''s journal — the boring parts', 1, 'journal'),
  (UUID(), @fam, @m3, 7, 'F-07', 'The oath — 1 of 3', 2, 'oath'),
  (UUID(), @fam, @m3, 8, 'F-08', 'The oath — 2 of 3', 2, 'oath'),
  (UUID(), @fam, @m3, 9, 'F-09', 'The oath — 3 of 3', 2, 'oath'),
  (UUID(), @fam, @m3, 10, 'F-10', 'Ruth''s page — the signatures', 2, 'signatures'),
  (UUID(), @fam, @m3, 11, 'F-11', 'Map fragment A — northwest', 2, 'map'),
  (UUID(), @fam, @m3, 12, 'F-12', 'Map fragment B — northeast', 2, 'map'),
  (UUID(), @fam, @m3, 13, 'F-13', 'Map fragment C — southwest', 2, 'map'),
  (UUID(), @fam, @m3, 14, 'F-14', 'Map fragment D — southeast', 2, 'map'),
  (UUID(), @fam, @m3, 15, 'F-15', 'Junie''s rhyme — first half', 2, 'rhyme'),
  (UUID(), @fam, @m3, 16, 'F-16', 'Nell''s journal — the swearing-in', 2, 'journal'),
  (UUID(), @fam, @m3, 17, 'F-17', 'The mirrored page', 2, 'mirrored'),
  (UUID(), @fam, @m3, 18, 'F-18', 'Nell''s journal — the strongbox', 3, 'journal'),
  (UUID(), @fam, @m3, 19, 'F-19', 'A Keeper''s number — the mill', 3, 'number'),
  (UUID(), @fam, @m3, 20, 'F-20', 'A Keeper''s number — the ford', 3, 'number'),
  (UUID(), @fam, @m3, 21, 'F-21', 'A Keeper''s number — the store', 3, 'number'),
  (UUID(), @fam, @m3, 22, 'F-22', 'A Keeper''s number — the school bell', 3, 'number'),
  (UUID(), @fam, @m3, 23, 'F-23', 'A Keeper''s number — the ferry', 3, 'number'),
  (UUID(), @fam, @m3, 24, 'F-24', 'A Keeper''s number — the orchard', 3, 'number'),
  (UUID(), @fam, @m3, 25, 'F-25', 'A Keeper''s number — the bridge', 3, 'number'),
  (UUID(), @fam, @m3, 26, 'F-26', 'Junie''s rhyme — second half', 3, 'rhyme'),
  (UUID(), @fam, @m3, 27, 'F-27', 'The crossing — coordinates', 4, 'coords'),
  (UUID(), @fam, @m3, 28, 'F-28', 'Nell''s last page', 4, 'final')
;
