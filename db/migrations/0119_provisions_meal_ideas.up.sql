-- Family → Provisions (2026-11-18): meal ideas written from the household's
-- Keep regulars, and one picture per dish (services/provisions).
--
-- An idea is the model's suggestion; whether the family has its ingredients is
-- worked out in code at read time against the live list, never stored here.
CREATE TABLE IF NOT EXISTS athena_meal_idea (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid          CHAR(36)        NOT NULL,
  profile_id    BIGINT          NOT NULL,
  slug          VARCHAR(80)     NOT NULL,   -- the dish, lower-case; also the picture's key
  title         VARCHAR(80)     NOT NULL,
  meal          VARCHAR(16)     NOT NULL,   -- dinner | lunch | breakfast | snack
  minutes       SMALLINT UNSIGNED NOT NULL,
  ingredients   JSON            NOT NULL,   -- ["chicken", "rice", ...]
  loved_by      JSON            NULL,       -- first names, checked against food preferences
  blurb         VARCHAR(160)    NULL,
  saved         TINYINT(1)      NOT NULL DEFAULT 0, -- the heart: kept when ideas are rewritten
  generated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_meal_idea_uuid (uuid),
  UNIQUE KEY uq_meal_idea_dish (profile_id, slug),
  KEY idx_meal_idea_profile (profile_id, generated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A dish's picture, painted once from its name alone (no names, no people, no
-- household data) and shared by every profile that is offered that dish.
CREATE TABLE IF NOT EXISTS athena_meal_image (
  slug        VARCHAR(80)  NOT NULL,
  mime        VARCHAR(32)  NOT NULL,
  bytes       MEDIUMBLOB   NOT NULL,
  model       VARCHAR(80)  NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
