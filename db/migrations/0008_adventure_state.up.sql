-- =====================================================================
-- 0008_adventure_state.up.sql
-- Per-adventure lifecycle tracking (pending → active → ended).
-- ---------------------------------------------------------------------
-- The Lake Norman Guardians game is always active (seeded below).
-- Rescue Ratatouille starts as 'pending' and is flipped to 'active'
-- atomically when the first enrolled Guardian signs in — that Guardian
-- becomes activated_by_guardian_id. An admin can manually set
-- scheduled_end_at; the auth route checks ended_at to stop routing
-- players into ratatouille once it is over.
-- =====================================================================

CREATE TABLE IF NOT EXISTS adventure_state (
  adventure_key          VARCHAR(60)  NOT NULL,
  state                  VARCHAR(20)  NOT NULL DEFAULT 'pending',  -- pending | active | ended
  activated_at           DATETIME     NULL,
  activated_by_guardian_id VARCHAR(8) NULL,
  scheduled_end_at       DATETIME     NULL,
  ended_at               DATETIME     NULL,
  created_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (adventure_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lake Norman Guardians is always on.
INSERT INTO adventure_state (adventure_key, state, activated_at)
VALUES ('lake_norman_guardians', 'active', NOW())
ON DUPLICATE KEY UPDATE state = 'active';

-- Rescue Ratatouille starts pending — triggered by first player sign-in.
INSERT INTO adventure_state (adventure_key, state)
VALUES ('rescue_ratatouille', 'pending')
ON DUPLICATE KEY UPDATE adventure_key = adventure_key;
