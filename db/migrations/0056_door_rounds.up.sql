-- Door-to-door safety checks (owner, 2026-10-06): in an emergency the person
-- walks their street and marks each house safe / no answer / needs help. A
-- round is one street, listed ahead of time from OpenStreetMap address points
-- plus the person's own neighbour households; a check is one address in it.
-- Addresses only - no resident is named or inferred here. Statuses are the
-- person's own marks and are kept until they delete the round.
CREATE TABLE IF NOT EXISTS athena_door_round (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid        CHAR(36)        NOT NULL,
  profile_id  BIGINT          NOT NULL,
  street      VARCHAR(120)    NOT NULL,
  place_uuid  CHAR(36)        NULL,
  source      VARCHAR(20)     NOT NULL DEFAULT 'osm',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at   DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_door_round_uuid (uuid),
  KEY idx_athena_door_round_profile (profile_id, closed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_door_check (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  round_id    BIGINT UNSIGNED NOT NULL,
  profile_id  BIGINT          NOT NULL,
  address     VARCHAR(160)    NOT NULL,
  address_key VARCHAR(160)    NOT NULL,
  position    INT             NOT NULL DEFAULT 0,
  status      ENUM('todo','safe','no_answer','needs_help','skipped') NOT NULL DEFAULT 'todo',
  note        VARCHAR(500)    NULL,
  checked_at  DATETIME(3)     NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_door_check_address (round_id, address_key),
  KEY idx_athena_door_check_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
