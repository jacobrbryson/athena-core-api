-- Card games Athena plays with a child (currently Go Fish).
--
-- A language model cannot hold a hidden hand across turns — it forgets what it
-- was dealt, contradicts itself, and quietly cheats. So the deal, the hands and
-- the rules live here, server-side and authoritative; Athena is told what she
-- holds and what just happened, and her only job is to narrate it.
--
-- Scoped to the session, so each child has their own game.

CREATE TABLE IF NOT EXISTS guardian_game (
  session_id INT          NOT NULL,
  game       VARCHAR(32)  NOT NULL,
  state      JSON         NOT NULL,
  status     VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, game)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
