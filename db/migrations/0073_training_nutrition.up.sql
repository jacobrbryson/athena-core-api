-- Training programs and nutrition for the Health page (2026-10-14).
--
-- WHOOP records that a workout happened and how hard the heart worked; it has
-- no idea what the person *meant* to do. A program is that intent: a weekly
-- pattern of sessions (Gym A upper, a 3-5 mile run, soccer on Saturday) over a
-- number of weeks. A session counts as done when the person ticks it, or when
-- a recorded workout of the matching kind lands on that day (computed on read,
-- never stored, so a re-synced workout can't leave a stale tick behind).
--
-- Nutrition is what the person logs themselves — the scale and WHOOP can't
-- see a plate — plus the daily targets the Health page measures it against.
-- All of it is the adult's own; children never reach these routes.

CREATE TABLE IF NOT EXISTS training_program (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  name VARCHAR(80) NOT NULL,
  goal VARCHAR(255) NULL,
  starts_on DATE NOT NULL,
  weeks SMALLINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  -- Ending a program soft-deletes it; the logs that point at it stay.
  ended_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_training_program_uuid (uuid),
  KEY idx_training_program_profile (profile_id, ended_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One slot in the weekly pattern. weekday 0 = Monday … 6 = Sunday; more than
-- one session on a day is allowed (a run in the morning, lifting at night).
CREATE TABLE IF NOT EXISTS training_session (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  program_id BIGINT UNSIGNED NOT NULL,
  weekday TINYINT UNSIGNED NOT NULL,
  -- gym | run | ride | sport | recovery | rest | other
  kind VARCHAR(16) NOT NULL,
  title VARCHAR(60) NOT NULL,
  focus VARCHAR(60) NULL,
  detail VARCHAR(255) NULL,
  -- ["Leg press","RDL",...] — names only; no sets/reps prescribed yet.
  exercises JSON NULL,
  sort SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_training_session_uuid (uuid),
  KEY idx_training_session_program (program_id, weekday, sort),
  CONSTRAINT fk_training_session_program FOREIGN KEY (program_id) REFERENCES training_program (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The person's own mark on a session for a date: done or skipped. No row means
-- unmarked (a matching WHOOP workout may still show it done).
CREATE TABLE IF NOT EXISTS training_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id BIGINT NOT NULL,
  session_id BIGINT UNSIGNED NOT NULL,
  done_on DATE NOT NULL,
  status VARCHAR(8) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_training_log_day (session_id, done_on),
  KEY idx_training_log_profile (profile_id, done_on),
  CONSTRAINT fk_training_log_session FOREIGN KEY (session_id) REFERENCES training_session (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per person: what a day should add up to. Every target is optional.
CREATE TABLE IF NOT EXISTS nutrition_target (
  profile_id BIGINT NOT NULL,
  calories SMALLINT UNSIGNED NULL,
  protein_g SMALLINT UNSIGNED NULL,
  carbs_g SMALLINT UNSIGNED NULL,
  fat_g SMALLINT UNSIGNED NULL,
  water_oz SMALLINT UNSIGNED NULL,
  sleep_hours DECIMAL(3,1) NULL,
  target_weight_low_kg DECIMAL(5,2) NULL,
  target_weight_high_kg DECIMAL(5,2) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What was eaten or drunk, on the person's own local date. A glass of water is
-- an entry with only water_oz.
CREATE TABLE IF NOT EXISTS nutrition_entry (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  eaten_on DATE NOT NULL,
  label VARCHAR(120) NOT NULL,
  calories SMALLINT UNSIGNED NULL,
  protein_g DECIMAL(5,1) NULL,
  carbs_g DECIMAL(5,1) NULL,
  fat_g DECIMAL(5,1) NULL,
  water_oz DECIMAL(5,1) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_nutrition_entry_uuid (uuid),
  KEY idx_nutrition_entry_day (profile_id, eaten_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
