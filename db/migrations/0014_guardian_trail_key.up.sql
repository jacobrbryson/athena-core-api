-- Rescue Ratatouille Mission 1 "The Trail to Ratatouille": single-use
-- decryption keys reported by each guardian team.
--
-- One row per key a team has reported. `clue_index` is the order of use —
-- clues always unlock strictly in order, whichever valid key is reported —
-- and `status` is the two-step flow: 'pending' after the key is accepted,
-- 'used' once the decryption challenges are completed and the clue revealed.
-- Progress is per guardian credential, so the seeded test account can run the
-- whole hunt without touching the real team's game.

CREATE TABLE IF NOT EXISTS guardian_trail_key (
  guardian_id  VARCHAR(8)  NOT NULL,
  mission_key  VARCHAR(80) NOT NULL,
  key_code     VARCHAR(16) NOT NULL,
  clue_index   INT         NOT NULL,
  status       VARCHAR(12) NOT NULL DEFAULT 'pending',
  reported_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at      DATETIME    NULL,
  PRIMARY KEY (guardian_id, mission_key, key_code),
  UNIQUE KEY uq_guardian_trail_clue (guardian_id, mission_key, clue_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
