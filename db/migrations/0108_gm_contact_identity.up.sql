-- Who is on the other end (docs/capabilities/guardians-missions.md, owner
-- 2026-10-31). paired_device says which account a phone, browser or number
-- belongs to; this says which Guardian or parent that means, so a text to a
-- number or a push to a device has a person attached.
--
-- A contact point references paired_device and never copies a number or a
-- token: those stay encrypted there, and nothing here can leak one. A link is
-- ended (valid_to), not deleted, so a recycled number or a handed-down phone
-- cannot rewrite who an old message was with.
--
-- trust says how sure a message from this point is who it claims to be. It is
-- description, not authorization: no trust level approves anything.
--   session     signed in to the app
--   paired      a device paired to their account
--   number      a phone number (a phone can be borrowed)
--   shared      used by more than one person, such as a family tablet or walkie
--   unverified  known about, not proven
CREATE TABLE IF NOT EXISTS athena_gm_contact_point (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  channel ENUM('push','sms','email','watch','walkie','chat','voice') NOT NULL,
  device_id BIGINT UNSIGNED NULL,
  name VARCHAR(80) NULL,
  trust ENUM('session','paired','number','shared','unverified') NOT NULL DEFAULT 'unverified',
  verified_at DATETIME NULL,
  valid_from DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to DATETIME NULL,
  -- 1 while current, NULL once ended: one open link per person and device, as
  -- many ended ones as history needs.
  is_open TINYINT GENERATED ALWAYS AS (IF(valid_to IS NULL, 1, NULL)) STORED,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_contact_uuid (uuid),
  UNIQUE KEY uq_gm_contact_open (actor_id, channel, device_id, is_open),
  KEY idx_gm_contact_actor (actor_id, valid_to),
  KEY idx_gm_contact_device (device_id, channel, valid_to),
  KEY idx_gm_contact_family (family_id, valid_to),
  CONSTRAINT fk_gm_contact_actor FOREIGN KEY (actor_id) REFERENCES athena_gm_actor (id) ON DELETE CASCADE,
  CONSTRAINT fk_gm_contact_device FOREIGN KEY (device_id) REFERENCES paired_device (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every message in or out with a Guardian or parent, append-only. No message
-- text and no address: this says who, how and when. No foreign keys, like
-- athena_gm_log: history outlives what it points at.
CREATE TABLE IF NOT EXISTS athena_gm_contact_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  contact_point_id BIGINT UNSIGNED NULL,
  direction ENUM('in','out') NOT NULL,
  channel ENUM('push','sms','email','watch','walkie','chat','voice') NOT NULL,
  trust ENUM('session','paired','number','shared','unverified') NOT NULL DEFAULT 'unverified',
  outcome ENUM('sent','failed','received') NOT NULL,
  mission_id BIGINT UNSIGNED NULL,
  step_id BIGINT UNSIGNED NULL,
  reason VARCHAR(160) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_gm_contact_event_actor (actor_id, created_at),
  KEY idx_gm_contact_event_family (family_id, created_at),
  KEY idx_gm_contact_event_step (step_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A person's voiceprint (owner, 2026-10-31: Athena stores it). Biometric data,
-- so it stays apart from everything else: encrypted JSON in print_enc, one row
-- per person per model because prints from different models don't compare, and
-- deleted outright when consent is withdrawn. consent_event_id is required: no
-- print without the agreement that allowed it. It points at the consent record
-- the opt-in work adds. Never sent to a model; a match can suggest who is
-- speaking and never approves anything.
CREATE TABLE IF NOT EXISTS athena_gm_voiceprint (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  family_id BIGINT NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  model VARCHAR(80) NOT NULL,
  print_enc MEDIUMTEXT NOT NULL,
  sample_count SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  consent_event_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_voiceprint_uuid (uuid),
  UNIQUE KEY uq_gm_voiceprint_actor_model (actor_id, model),
  CONSTRAINT fk_gm_voiceprint_actor FOREIGN KEY (actor_id) REFERENCES athena_gm_actor (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A kid may be a Guardians app login with no family account behind it, as Lena
-- and Livia are. This says which login an actor is. It is a reference only:
-- nothing here reads or changes a credential.
ALTER TABLE athena_gm_actor
  ADD COLUMN guardian_credential_id BIGINT UNSIGNED NULL AFTER child_profile_id;

UPDATE athena_gm_actor a
JOIN guardian_credential g ON g.display_name = CONCAT(a.display_name, ' Bryson') AND g.participant_type = 'guardian'
SET a.guardian_credential_id = g.id
WHERE a.kind = 'kid';

-- The Wolfer family (owner, 2026-10-31): Jenny is the parent of Lena and
-- Livia, in her own family, with no access to anyone else's.
SET @wolfer := (SELECT family_id FROM family_members WHERE display_name = 'Jenny Wolfer' AND role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1);
SET @jenny := (SELECT profile_id FROM family_members WHERE display_name = 'Jenny Wolfer' AND role = 'owner' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1);

INSERT INTO athena_gm_control (family_id) SELECT @wolfer FROM DUAL WHERE @wolfer IS NOT NULL
ON DUPLICATE KEY UPDATE family_id = family_id;

INSERT INTO athena_gm_actor (uuid, family_id, actor_key, kind, display_name, profile_id, audience)
SELECT UUID(), @wolfer, 'jenny', 'parent', 'Jenny', @jenny, 'kids_too' FROM DUAL WHERE @wolfer IS NOT NULL
ON DUPLICATE KEY UPDATE profile_id = VALUES(profile_id);

INSERT INTO athena_gm_actor (uuid, family_id, actor_key, kind, display_name, guardian_credential_id, audience)
SELECT UUID(), @wolfer, LOWER(SUBSTRING_INDEX(g.display_name, ' ', 1)), 'kid', SUBSTRING_INDEX(g.display_name, ' ', 1), g.id, 'kids_too'
FROM guardian_credential g
WHERE @wolfer IS NOT NULL AND g.display_name IN ('Lena Wolfer', 'Livia Wolfer') AND g.participant_type = 'guardian' AND g.is_active = 1
ON DUPLICATE KEY UPDATE guardian_credential_id = VALUES(guardian_credential_id);
