-- =====================================================================
-- 0130_collections.up.sql
-- Collections (owner, 2026-11-28; design: claude.ai/artifact/HiT81qEfBoXFBpQRpUNCNG).
-- "The real goal is that I ask Athena for that and she facilitates all those
-- changes internally without code changes and just database updates."
--
-- A collection is a kind of thing defined as DATA: a Christmas list, a
-- birthday list, a maintenance log. Athena drafts the definition in chat, the
-- person approves it (define_collection), and the generic engine stores,
-- shows and edits it. No collection ever gets a table of its own and no model
-- writes DDL: every item lives in athena_collection_item, its fields JSON
-- checked against the definition by code (services/collections).
-- ---------------------------------------------------------------------
-- athena_collection — one row per collection.
--   slug         — stable handle, unique per profile ("christmas-list-2026").
--   definition   — JSON: purpose, fields [{name,type,choices,required}],
--                  statuses, perPerson, capture (plain-language rule), home
--                  ("top" | "after" | "off"). Validated in code.
--   version      — bumped whenever the definition changes.
--   ends_on      — last day it is active; after it the card leaves Home and
--                  the collection reads as archived. NULL = no end.
--   archived_at  — archived early, or by the nightly sweep after ends_on.
--
-- athena_collection_subject — the people a per-person collection is about
-- (the Christmas list's "Ashlynn, Skylar, Thomas"), checked off with done_at.
--   person_key   — the Family roster's key: a user_memory uuid, or
--                  child:<child_profiles.uuid> (services/personPage.js).
--
-- athena_collection_item — one thing in a collection.
--   subject_id   — the person it is for, on a per-person collection.
--   status       — one of the definition's statuses, or 'suggested' for
--                  something Athena found that the person hasn't kept yet.
--   fields       — JSON of the definition's other fields.
--   source_kind / source_ref — where it came from ('chat', 'memory', 'person',
--                  'athena' for her own idea, 'email'); a pointer, never the
--                  original text. Forgetting the source removes the item.
--   removed_at   — remove is a hide with undo (30 days), never a delete.
--
-- athena_entity_alias — "who do you mean" answers the person confirmed:
-- "uncle Mark" is this roster key, for good (services/entities).
--
-- Every row carries profile_id; every read is built by code and scoped to it.
-- Conventions match 0001-0129.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_collection (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  profile_id BIGINT NOT NULL,
  slug VARCHAR(80) NOT NULL,
  name VARCHAR(120) NOT NULL,
  definition JSON NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  ends_on DATE NULL,
  archived_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_collection_uuid (uuid),
  UNIQUE KEY uq_collection_slug (profile_id, slug),
  KEY idx_collection_profile (profile_id, archived_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_collection_subject (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  collection_id BIGINT UNSIGNED NOT NULL,
  profile_id BIGINT NOT NULL,
  person_key VARCHAR(64) NOT NULL,
  label VARCHAR(120) NOT NULL,
  done_at DATETIME NULL,
  removed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_subject_uuid (uuid),
  UNIQUE KEY uq_subject_person (collection_id, person_key),
  KEY idx_subject_profile (profile_id, person_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_collection_item (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  collection_id BIGINT UNSIGNED NOT NULL,
  profile_id BIGINT NOT NULL,
  subject_id BIGINT UNSIGNED NULL,
  title VARCHAR(200) NOT NULL,
  status VARCHAR(32) NOT NULL,
  fields JSON NULL,
  source_kind VARCHAR(16) NOT NULL,
  source_ref VARCHAR(64) NULL,
  reason VARCHAR(255) NULL,
  removed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_item_uuid (uuid),
  KEY idx_item_collection (collection_id, removed_at),
  KEY idx_item_subject (subject_id),
  KEY idx_item_source (profile_id, source_kind, source_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_entity_alias (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id BIGINT NOT NULL,
  alias VARCHAR(120) NOT NULL,
  person_key VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_alias (profile_id, alias),
  KEY idx_alias_person (profile_id, person_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
