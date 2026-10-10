-- =====================================================================
-- 0058_capability_gap.up.sql
-- Capability gaps: each time something Athena proposed was turned down and
-- she had to repair it, offer something else, or give up. The nightly
-- review rolls these up into "people asked for X and she couldn't" — the
-- evidence for building the missing thing. See services/capabilityGaps.js.
--
-- `asked` is the person's own message, clipped; it already lives in
-- `message`, and the review reads only counts by action and reason.
-- Conventions match 0001-0057: no enforced FKs (integrity in the service).
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_capability_gap (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id  BIGINT          NOT NULL,
  session_id  BIGINT          NULL,
  action_id   VARCHAR(64)     NULL,       -- what she proposed, when it named one
  stage       VARCHAR(20)     NOT NULL,   -- params | unavailable | unknown | execute | error
  reason      VARCHAR(300)    NOT NULL,   -- why it was turned down, in words
  outcome     VARCHAR(20)     NOT NULL,   -- repaired | offered | failed
  asked       VARCHAR(300)    NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_capability_gap_created (created_at),
  KEY idx_capability_gap_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
