-- 0126_gm_mission_badges.up.sql
-- Mission badges (owner, 11-24): every finished mission has a badge with its own
-- art, earned by each kid who did their part, and by Athena when the mission is
-- one she plays in (I Spy's First Sight is her first). Skill badges stay as they
-- are in athena_gm_skill; these are a separate keepsake.
CREATE TABLE athena_gm_badge (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  badge_key VARCHAR(60) NOT NULL,
  -- A Guardians-app mission (adventure-wide) by key, or one of Athena's missions by id.
  mission_key VARCHAR(80) NULL,
  mission_id BIGINT UNSIGNED NULL,
  name VARCHAR(80) NOT NULL,
  story VARCHAR(400) NOT NULL,
  art VARCHAR(200) NULL,
  with_athena TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gm_badge_key (badge_key),
  KEY ix_gm_badge_mission (mission_id),
  KEY ix_gm_badge_mission_key (mission_key)
);

CREATE TABLE athena_gm_badge_award (
  badge_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  earned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source ENUM('mission','backfill') NOT NULL DEFAULT 'mission',
  PRIMARY KEY (badge_id, actor_id),
  KEY ix_gm_badge_award_actor (actor_id)
);
