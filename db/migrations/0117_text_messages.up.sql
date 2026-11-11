-- Reading incoming texts (owner, 2026-11-10): the Android app forwards each new
-- Google Messages text; core_api checks it for an event that is missing from,
-- or thin on, the calendar, and summarises long ones with a suggested reply.
--
-- The text itself is NEVER stored. athena_text_message is one row per text
-- seen — a dedupe key (a hash) and what came of it — so "she never said
-- anything about that text" has an answer. athena_text_suggestion holds only
-- what Athena offered: the calendar change (as action params) or the summary
-- and reply. Suggestions are deleted a week after they were made.

CREATE TABLE IF NOT EXISTS athena_text_message (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_id  BIGINT          NOT NULL,
  -- sha256(thread | posted_at | text): the phone re-posts a conversation's
  -- whole history with every new message, so this is what makes it once.
  dedupe_key  CHAR(64)        NOT NULL,
  length      INT UNSIGNED    NOT NULL DEFAULT 0,
  --   processing | nothing | suggested | failed | skipped
  outcome     VARCHAR(16)     NOT NULL DEFAULT 'processing',
  -- Why, in our own words (never the text): "event already on the calendar".
  note        VARCHAR(200)    NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_text_message (profile_id, dedupe_key),
  KEY idx_athena_text_message_created (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_text_suggestion (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid          CHAR(36)        NOT NULL,
  profile_id    BIGINT          NOT NULL,
  message_id    BIGINT UNSIGNED NOT NULL,
  --   calendar  add or update an event (action_id + params)
  --   reply     summary + suggested reply, which the phone puts in Messages
  kind          VARCHAR(16)     NOT NULL,
  -- Opaque key the phone made for the conversation. The sender's number
  -- stays on the phone; this is how it finds it again.
  thread_key    VARCHAR(64)     NULL,
  sender_label  VARCHAR(120)    NULL,
  action_id     VARCHAR(64)     NULL,
  params        JSON            NULL,
  -- What the notification says. Model-authored; shown, never parsed back.
  summary       VARCHAR(500)    NOT NULL,
  reply_text    VARCHAR(1000)   NULL,
  --   open | approved | declined | failed | expired
  status        VARCHAR(16)     NOT NULL DEFAULT 'open',
  error         VARCHAR(300)    NULL,
  nudge_uuid    CHAR(36)        NULL,
  action_uuid   CHAR(36)        NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME        NOT NULL,
  decided_at    DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_text_suggestion_uuid (uuid),
  UNIQUE KEY uq_athena_text_suggestion_kind (message_id, kind),
  KEY idx_athena_text_suggestion_nudge (nudge_uuid),
  KEY idx_athena_text_suggestion_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
