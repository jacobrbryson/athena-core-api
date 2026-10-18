-- =====================================================================
-- 0083_sightings.up.sql
-- Who and what the household cameras saw: a gallery of known people, pets
-- and vehicles, the sightings log, camera zones, and alert rules.
-- See src/services/sightings.js and docs/capabilities/sightings.md.
--
-- Owner, 2026-10-18: "log anything alive (or cars) when motion is detected
-- ... as specific as 'Dexter', 'Wynter', ... and stranger(s)", so that "when
-- was the last time you saw Wynter" has an answer, plus a push when a dog is
-- outside the back fence (held through quiet hours like every other alert).
--
-- Retention (owner, 2026-10-18): sightings and their frames are deleted
-- after 30 days by the nightly job. Removing a subject deletes its sightings.
-- Strangers are never identified beyond the label "stranger".
--
-- Household-wide and visible only to EUFY_AUTHORIZED_PROFILE_IDS adults.
-- Conventions match 0001-0082: no enforced FKs.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_sighting_subject (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid         CHAR(36)        NOT NULL,
  name         VARCHAR(60)     NOT NULL,  -- "Wynter", "Red van"
  kind         VARCHAR(8)      NOT NULL,  -- person | animal | vehicle
  description  VARCHAR(300)    NULL,      -- "black lab, white chest"
  created_by   BIGINT          NOT NULL,
  created_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_sighting_subject_uuid (uuid),
  UNIQUE KEY uq_athena_sighting_subject_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reference photos are kept security images (athena_security_media.uuid).
CREATE TABLE IF NOT EXISTS athena_sighting_subject_photo (
  subject_id   BIGINT UNSIGNED NOT NULL,
  media_uuid   CHAR(36)        NOT NULL,
  added_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (subject_id, media_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Named areas a camera can see, e.g. Backyard: "inside the fence",
-- "outside the back fence". The model picks one per subject; rules match on it.
CREATE TABLE IF NOT EXISTS athena_camera_zone (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_serial VARCHAR(40)     NOT NULL,
  name          VARCHAR(60)     NOT NULL,
  description   VARCHAR(200)    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_camera_zone (device_serial, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per subject seen in one motion frame.
CREATE TABLE IF NOT EXISTS athena_sighting (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid          CHAR(36)        NOT NULL,
  event_id      VARCHAR(160)    NOT NULL,  -- the bridge's event key
  event_kind    VARCHAR(10)     NOT NULL,  -- motion | doorbell | person
  device_serial VARCHAR(40)     NOT NULL,
  device_name   VARCHAR(120)    NULL,
  seen_at       DATETIME(3)     NOT NULL,
  subject_id    BIGINT UNSIGNED NULL,      -- null: stranger or unknown
  label         VARCHAR(60)     NOT NULL,  -- subject name, "stranger", "unknown dog"...
  kind          VARCHAR(8)      NOT NULL,  -- person | animal | vehicle
  zone          VARCHAR(60)     NULL,
  where_text    VARCHAR(200)    NULL,      -- "by the back fence"
  confidence    DECIMAL(3,2)    NULL,
  frame_uri     VARCHAR(512)    NULL,      -- gs:// path, shared by one frame's rows
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_sighting_uuid (uuid),
  KEY idx_athena_sighting_recent (seen_at),
  KEY idx_athena_sighting_subject (subject_id, seen_at),
  KEY idx_athena_sighting_label (label, seen_at),
  KEY idx_athena_sighting_event (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "Tell me when <subject | any stranger> is seen [on <camera>] [in <zone>]."
-- Delivered through initiative (trigger sighting_alert): opt-in, mutes,
-- per-occurrence dedupe and quiet-hours hold all apply.
CREATE TABLE IF NOT EXISTS athena_sighting_rule (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid          CHAR(36)        NOT NULL,
  profile_id    BIGINT          NOT NULL,  -- who is told
  subject_id    BIGINT UNSIGNED NULL,      -- one of subject_id / label is set
  label         VARCHAR(60)     NULL,      -- "stranger"
  device_serial VARCHAR(40)     NULL,
  zone          VARCHAR(60)     NULL,
  enabled       TINYINT(1)      NOT NULL DEFAULT 1,
  created_at    DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_sighting_rule_uuid (uuid),
  KEY idx_athena_sighting_rule_profile (profile_id, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
