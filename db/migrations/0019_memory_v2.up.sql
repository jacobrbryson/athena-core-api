-- Memory v2: episodic memory + embeddings for semantic recall.
--
-- user_memory (0001) stays the canonical store of durable FACTS ("semantic"
-- memory: Ross has a dog named Biscuit). memory_event adds EPISODES — things
-- that happened: conversations, photos Athena was shown, news she read, what
-- she saw through a camera, and her own nightly reflections.
--
-- Photos never live here: media_ref is an opaque device-local reference, and
-- only Athena's description of the image (plus its embedding) is stored.

CREATE TABLE IF NOT EXISTS memory_event (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid             CHAR(36)        NOT NULL,
  profile_id       BIGINT          NULL,             -- NULL for world-scope (news)
  family_id        BIGINT UNSIGNED NULL,
  scope            VARCHAR(16)     NOT NULL DEFAULT 'personal', -- personal | family | world
  kind             VARCHAR(24)     NOT NULL,         -- conversation | photo | news | observation | event | reflection | drive
  title            VARCHAR(200)    NULL,
  content          TEXT            NOT NULL,
  occurred_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  importance       TINYINT         NOT NULL DEFAULT 5, -- 1..10
  source           VARCHAR(20)     NOT NULL DEFAULT 'ai', -- user | parent | ai | device | feed
  visibility       VARCHAR(20)     NOT NULL DEFAULT 'private', -- private | family
  session_id       BIGINT          NULL,
  media_ref        VARCHAR(255)    NULL,
  dedupe_key       CHAR(40)        NULL,             -- e.g. sha1(news link); unique per scope
  metadata         JSON            NULL,
  recall_count     INT             NOT NULL DEFAULT 0,
  last_recalled_at DATETIME        NULL,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at       DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_memory_event_uuid (uuid),
  UNIQUE KEY uq_memory_event_dedupe (scope, dedupe_key),
  KEY idx_memory_event_profile (profile_id, occurred_at),
  KEY idx_memory_event_scope (scope, kind, occurred_at),
  FULLTEXT KEY ft_memory_event (title, content)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Keyword half of hybrid recall over durable facts.
ALTER TABLE user_memory ADD FULLTEXT KEY ft_user_memory (memory_key, memory_value);

-- One vector per (memory, embedding space). A "space" is "<endpoint>:<model>";
-- vectors are only ever compared within the same space, so switching models is
-- a background re-embed, never silent corruption.
CREATE TABLE IF NOT EXISTS memory_embedding (
  id           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  memory_type  VARCHAR(8)       NOT NULL,   -- event | fact
  memory_id    BIGINT UNSIGNED  NOT NULL,
  profile_id   BIGINT           NULL,       -- denormalized for per-profile index loads
  space        VARCHAR(120)     NOT NULL,
  dims         SMALLINT UNSIGNED NOT NULL,
  vector       MEDIUMBLOB       NOT NULL,   -- float32 little-endian
  content_hash CHAR(40)         NOT NULL,   -- re-embed when the text changes
  created_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_memory_embedding (memory_type, memory_id, space),
  KEY idx_memory_embedding_profile (profile_id, space, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Where background extraction left off in each session's transcript.
CREATE TABLE IF NOT EXISTS memory_extraction_cursor (
  session_id      BIGINT   NOT NULL,
  last_created_at DATETIME NULL,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
