-- "Right now": the places a person actually goes, and the board their
-- around-the-house projects live on. Both exist so the dashboard can answer
-- "what should I do with the next four hours" instead of listing seven cards.
--
-- A place is a page Athena reads, like a news source, but what she keeps from
-- it is a state rather than headlines: open or closed, the hours, and whether
-- those hours are conditional on weather. Distance is typed by the person and
-- never derived from location samples — this table must not become a second,
-- weaker copy of athena_location_sample.
CREATE TABLE IF NOT EXISTS athena_place (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  label VARCHAR(120) NOT NULL,
  url VARCHAR(500) NOT NULL,
  host VARCHAR(190) NOT NULL,
  -- Free text, deliberately: "mountain biking" is what the person calls it and
  -- what has to line up with a Strava sport type, not an enum we invented.
  activity VARCHAR(64) NOT NULL,
  distance_mi DECIMAL(6,2) NULL,
  latitude DECIMAL(9,6) NULL,
  longitude DECIMAL(9,6) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  -- What the last read of the page said. `unknown` is honest and common: a
  -- page that does not state a status must never be reported as open.
  status_state ENUM('open','closed','unknown') NOT NULL DEFAULT 'unknown',
  status_text VARCHAR(190) NULL,
  weather_dependent TINYINT(1) NOT NULL DEFAULT 0,
  -- { "mon": [["07:00","19:30"]], ... }; absent days mean closed, a missing
  -- object means the page never said.
  hours_json JSON NULL,
  content_hash CHAR(40) NULL,
  etag VARCHAR(190) NULL,
  last_modified VARCHAR(190) NULL,
  robots_allowed TINYINT(1) NULL,
  robots_checked_at DATETIME NULL,
  next_check_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_checked_at DATETIME NULL,
  last_changed_at DATETIME NULL,
  consecutive_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_place_uuid (uuid),
  UNIQUE KEY uq_athena_place_url (profile_id, url(190)),
  KEY idx_athena_place_due (enabled, next_check_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Around-the-house projects, owned here rather than pointed at.
--
-- They began life in a spreadsheet and could have stayed there behind a Google
-- Sheets scope, but a row that only Athena can read is not actionable: she has
-- to be able to say "two hours, the garage shelves" and record that it moved.
-- `effort_minutes` and `indoor` are the two fields that earn their place —
-- the first is what matches a project to the gap before the next commitment,
-- the second is what makes a project the answer when the trails are washed out.
CREATE TABLE IF NOT EXISTS athena_home_project (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  title VARCHAR(190) NOT NULL,
  detail TEXT NULL,
  area VARCHAR(80) NULL,
  status ENUM('todo','in_progress','blocked','done') NOT NULL DEFAULT 'todo',
  priority ENUM('low','normal','high') NOT NULL DEFAULT 'normal',
  effort_minutes INT UNSIGNED NULL,
  -- NULL means nobody said. Not the same as false, and never guessed.
  indoor TINYINT(1) NULL,
  cost_estimate DECIMAL(10,2) NULL,
  due_date DATE NULL,
  blocked_on VARCHAR(190) NULL,
  last_progress_at DATETIME NULL,
  completed_at DATETIME NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'manual',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_home_project_uuid (uuid),
  KEY idx_athena_home_project_open (profile_id, status, priority),
  KEY idx_athena_home_project_due (profile_id, due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
