-- =====================================================================
-- 0122_person_page.up.sql
-- A page for each person Athena knows (owner, 2026-11-22). Most of what it
-- shows already exists — the person's memory (user_memory), their Google
-- Contact, child profile, health watches, calendar, sightings, memory
-- events — and is read where it lives. These tables hold only what the page
-- adds that had nowhere to go: the person's own write-up and relation,
-- their interests and favorites, and who they're related to.
-- ---------------------------------------------------------------------
-- person_key identifies the person the way the Family roster does: a
-- remembered person's user_memory.uuid, or `child:<child_profiles.uuid>` for
-- a child on the family's profiles with no memory of their own. Scoped per
-- profile (whoever is looking), like user_memory and athena_family_contact.
--
-- Conventions match 0001-0121: BIGINT UNSIGNED ids, no enforced FKs,
-- idempotent CREATE TABLE IF NOT EXISTS.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_person (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id  BIGINT          NOT NULL,
  person_key  VARCHAR(48)     NOT NULL,
  about       VARCHAR(600)    NULL,     -- "Our creative, energetic 4th grader…"; NULL = use the memory's own words
  relation    VARCHAR(60)     NULL,     -- overrides what the roster reads from memories ("Daughter")
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_person_key (profile_id, person_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_person_interest (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid        CHAR(36)        NOT NULL,
  profile_id  BIGINT          NOT NULL,
  person_key  VARCHAR(48)     NOT NULL,
  label       VARCHAR(60)     NOT NULL,
  icon        VARCHAR(24)     NULL,     -- one of the page's icon names; NULL = a star
  sort_order  SMALLINT        NOT NULL DEFAULT 0,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at  DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_person_interest_uuid (uuid),
  KEY idx_athena_person_interest_person (profile_id, person_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_person_relation (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid        CHAR(36)        NOT NULL,
  profile_id  BIGINT          NOT NULL,
  person_key  VARCHAR(48)     NOT NULL,
  other_key   VARCHAR(48)     NOT NULL, -- another person_key in the same family
  label       VARCHAR(60)     NOT NULL, -- what the other person is to this one: "Brother", "Mom", "Pet (dog)"
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at  DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_person_relation_uuid (uuid),
  KEY idx_athena_person_relation_person (profile_id, person_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
