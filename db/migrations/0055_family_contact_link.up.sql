-- A remembered family member (a user_memory person/family/pet fact) can be
-- linked to one of the person's Google Contacts (owner, 2026-10-06), so the
-- Family card can read birthdays, photos and phone numbers from the address
-- book instead of asking again. Only the People API id and a display-name
-- snapshot are kept; everything else is read from Google when shown.
-- One contact per fact, and a contact belongs to one fact per person.
CREATE TABLE IF NOT EXISTS athena_family_contact (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id    BIGINT          NOT NULL,
  fact_uuid     CHAR(36)        NOT NULL,
  contact_id    VARCHAR(20)     NOT NULL,
  contact_name  VARCHAR(160)    NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_family_contact_fact (profile_id, fact_uuid),
  UNIQUE KEY uq_athena_family_contact_contact (profile_id, contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
