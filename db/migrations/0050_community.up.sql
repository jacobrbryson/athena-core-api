-- =====================================================================
-- 0050_community.up.sql
-- Community: watched places become "points of interest", and two lists the
-- person keeps about the place they live — their neighbours and what is going
-- on locally (a church supper, Ham Day). All three are typed by the person on
-- the Community page and read into Athena's chat prompt, so she knows them
-- without being told again. See docs/capabilities/community.md.
--
-- Points of interest stay in athena_watch_place: every one is still watched
-- for 911 calls and weather exactly as before. `kind` only says what the
-- place is to the person (home, church, school...), never how it is watched.
--
-- Conventions match 0001-0049: no enforced FKs (integrity in the service),
-- place_uuid is a soft link that survives the place being removed.
-- =====================================================================

ALTER TABLE athena_watch_place
  ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'other' AFTER name,
  ADD COLUMN notes VARCHAR(500) NULL AFTER address;

UPDATE athena_watch_place SET kind = 'home' WHERE LOWER(name) = 'home';

CREATE TABLE IF NOT EXISTS athena_neighbor (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid        CHAR(36)        NOT NULL,
  profile_id  BIGINT          NOT NULL,
  name        VARCHAR(120)    NOT NULL,
  place_uuid  CHAR(36)        NULL,      -- which point of interest they live near
  where_text  VARCHAR(160)    NULL,      -- "two doors down, the blue house"
  contact     VARCHAR(120)    NULL,      -- a phone number or email, if they gave it
  notes       VARCHAR(500)    NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_neighbor_uuid (uuid),
  KEY idx_athena_neighbor_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_community_event (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid          CHAR(36)        NOT NULL,
  profile_id    BIGINT          NOT NULL,
  title         VARCHAR(160)    NOT NULL,
  starts_on     DATE            NOT NULL,
  ends_on       DATE            NULL,
  time_text     VARCHAR(60)     NULL,    -- "9am-3pm", as the flyer said it
  place_uuid    CHAR(36)        NULL,
  location_text VARCHAR(160)    NULL,    -- "Downtown Troutman", when not a saved place
  repeats       VARCHAR(10)     NOT NULL DEFAULT 'none', -- none | yearly
  url           VARCHAR(500)    NULL,
  notes         VARCHAR(500)    NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_community_event_uuid (uuid),
  KEY idx_athena_community_event_profile (profile_id, starts_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
