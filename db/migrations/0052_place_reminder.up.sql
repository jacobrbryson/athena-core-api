-- =====================================================================
-- 0052_place_reminder.up.sql
-- "Next time I'm at Missy's, remind me to ..." — a reminder that waits for a
-- place rather than a time. See docs/capabilities/place-reminders.md.
--
-- Created only through the action layer (remind_at_place): the person approves
-- the exact place and wording on a card, or has granted a standing approval.
-- The point is copied from the point of interest (or the geocoded address) at
-- approval time, so what is watched is exactly what the card showed — editing
-- the point of interest later does not move a reminder already set.
--
-- The phone holds a geofence per armed row and reports only an arrival inside
-- one; there is no trail. The server re-checks the distance before firing.
--
-- Conventions match 0001-0051: no enforced FKs, place_uuid is a soft link.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_place_reminder (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid          CHAR(36)        NOT NULL,
  profile_id    BIGINT          NOT NULL,
  place_uuid    CHAR(36)        NULL,      -- the point of interest, when it was one
  place_name    VARCHAR(80)     NOT NULL,  -- "Missy's"
  address       VARCHAR(255)    NULL,
  latitude      DECIMAL(9,6)    NOT NULL,
  longitude     DECIMAL(9,6)    NOT NULL,
  radius_m      SMALLINT UNSIGNED NOT NULL DEFAULT 150,
  text          VARCHAR(300)    NOT NULL,  -- what to remind them, as approved
  repeats       TINYINT(1)      NOT NULL DEFAULT 0, -- 0 = next visit only, 1 = every visit
  --   armed      waiting for an arrival
  --   done       a next-visit-only reminder that reached them
  --   cancelled  removed by the person
  status        VARCHAR(16)     NOT NULL DEFAULT 'armed',
  action_uuid   CHAR(36)        NULL,      -- the athena_action that approved it
  fire_count    INT UNSIGNED    NOT NULL DEFAULT 0,
  last_fired_at DATETIME        NULL,
  done_at       DATETIME        NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_place_reminder_uuid (uuid),
  KEY idx_athena_place_reminder_profile (profile_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
