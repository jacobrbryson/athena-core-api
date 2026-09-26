-- Dreaming: Athena reorganizing what she remembers into tables of her own.
--
-- Her tables live in a SEPARATE database (athena_mind, created by
-- db/mind-setup.js) that she can create, alter and drop freely through a user
-- with rights on that database only. What lives HERE, in the main database, is
-- the record of what she did there — deliberately out of her reach, so her own
-- permissions can never erase her history — and the questions she wants to
-- ask people.
--
-- Retention: athena_dream / athena_dream_step keep 30 days (pruned by the
-- nightly job). Answered questions are kept: an answer is data she rebuilds
-- from, not audit.

CREATE TABLE IF NOT EXISTS athena_dream (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid         CHAR(36)        NOT NULL,
  dream_date   DATE            NOT NULL,
  status       VARCHAR(16)     NOT NULL DEFAULT 'running', -- running | ok | partial | failed | skipped
  summary      TEXT            NULL,     -- her own account of the night, no personal details
  narrative    TEXT            NULL,     -- the same night told as a dream, for the dashboard
  served_by    VARCHAR(80)     NULL,
  stats        JSON            NULL,     -- counts: facts seen, steps ok/failed, rows purged, questions
  started_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at  DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_dream_uuid (uuid),
  KEY idx_athena_dream_date (dream_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per thing that happened during a dream, in order: every statement
-- she ran against athena_mind (verbatim), every guard action the code took
-- on her behalf, every question she queued.
CREATE TABLE IF NOT EXISTS athena_dream_step (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  dream_id      BIGINT UNSIGNED NOT NULL,
  seq           INT             NOT NULL,
  round         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  kind          VARCHAR(16)     NOT NULL, -- sql | upsert | describe | question | guard | purge | mirror | note
  statement     MEDIUMTEXT      NULL,
  why           TEXT            NULL,
  ok            TINYINT(1)      NOT NULL DEFAULT 1,
  error         VARCHAR(500)    NULL,
  affected_rows INT             NULL,
  ms            INT             NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_athena_dream_step_dream (dream_id, seq),
  CONSTRAINT fk_athena_dream_step_dream FOREIGN KEY (dream_id) REFERENCES athena_dream (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Something she could not settle from the data alone ("Is the Emma in Denver
-- your sister?"). Asked in conversation, and pushed as a nudge for people who
-- opted in to initiative. `offered_*` records the last conversation it was put
-- in front of her in; the next dream reads what was said there and decides
-- whether it was answered.
CREATE TABLE IF NOT EXISTS athena_dream_question (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid               CHAR(36)        NOT NULL,
  profile_id         BIGINT          NOT NULL,
  dream_id           BIGINT UNSIGNED NULL,
  question           VARCHAR(500)    NOT NULL,
  context            JSON            NULL,     -- fact ids / rows it is about
  status             VARCHAR(16)     NOT NULL DEFAULT 'pending', -- pending | answered | dismissed | expired
  offered_session_id BIGINT          NULL,
  offered_at         DATETIME        NULL,
  answer             TEXT            NULL,     -- her reading of what the person said
  answered_at        DATETIME        NULL,
  expires_at         DATETIME        NOT NULL,
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_dream_question_uuid (uuid),
  KEY idx_athena_dream_question_profile (profile_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
