-- A camera gallery person can be linked to one remembered person per viewer.
-- The remembered person's portrait remains private to that profile.
CREATE TABLE IF NOT EXISTS athena_sighting_person_link (
  profile_id BIGINT NOT NULL,
  subject_id BIGINT UNSIGNED NOT NULL,
  fact_uuid CHAR(36) NOT NULL,
  PRIMARY KEY (profile_id, subject_id),
  UNIQUE KEY uq_athena_sighting_person_fact (profile_id, fact_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
