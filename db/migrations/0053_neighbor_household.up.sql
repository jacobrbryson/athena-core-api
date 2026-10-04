-- =====================================================================
-- 0053_neighbor_household.up.sql
-- A neighbour is a HOUSEHOLD, keyed on its address, with any number of the
-- person's Google Contacts linked to it (owner, 2026-10-04: "keyed on address
-- with the ability to include multiple google contacts").
--
--   address      as the person gave it (or as the Census geocoder matched it)
--   address_key  the street line, normalized (services/community.js
--                streetKey): "152 Rushing Water Lane" and "152 RUSHING WATER
--                LN" are one house. One household per address per person.
--   name         now optional — "The Hendersons", or nothing and the linked
--                contacts' names stand in.
--
-- athena_neighbor_contact replaces the single contact_id from 0051. Only the
-- People API id and a display-name snapshot (so Athena's chat prompt can say
-- "Bill and Carol" without calling Google every turn) are kept; phone, email,
-- address and photo are read from Google when the page is shown. A contact
-- lives at one household: unique per (profile, contact).
--
-- Rows from before this migration have no address (address_key NULL, which
-- the unique key allows); the page asks for one the next time they're edited.
-- =====================================================================

ALTER TABLE athena_neighbor
  MODIFY COLUMN name VARCHAR(120) NULL,
  ADD COLUMN address VARCHAR(255) NULL AFTER name,
  ADD COLUMN address_key VARCHAR(160) NULL AFTER address,
  ADD COLUMN latitude DECIMAL(9,6) NULL AFTER address_key,
  ADD COLUMN longitude DECIMAL(9,6) NULL AFTER latitude,
  ADD UNIQUE KEY uq_athena_neighbor_address (profile_id, address_key);

CREATE TABLE IF NOT EXISTS athena_neighbor_contact (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  neighbor_id   BIGINT UNSIGNED NOT NULL,
  profile_id    BIGINT          NOT NULL,
  contact_id    VARCHAR(20)     NOT NULL,
  contact_name  VARCHAR(160)    NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_neighbor_contact (profile_id, contact_id),
  KEY idx_athena_neighbor_contact_neighbor (neighbor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO athena_neighbor_contact (neighbor_id, profile_id, contact_id)
SELECT id, profile_id, contact_id FROM athena_neighbor WHERE contact_id IS NOT NULL;

ALTER TABLE athena_neighbor DROP COLUMN contact_id;
