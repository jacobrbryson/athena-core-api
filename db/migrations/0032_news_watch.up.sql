-- =====================================================================
-- 0032_news_watch.up.sql
-- Athena watching news sites, on a schedule she sets herself.
-- ---------------------------------------------------------------------
-- 0031 stored a person's news as a JSON array of RSS/Atom feed URLs and
-- fetched all of them, live, every time the dashboard opened. Three
-- things were wrong with that. A feed URL is a thing you have to go and
-- find; most sites a person actually reads no longer publish one. Every
-- source was read at exactly the same rhythm, which is either too often
-- for a weekly column or far too rarely for an evening that is actually
-- happening. And nothing was ever kept, so nobody -- including Athena --
-- could tell what was NEW since the last look.
--
-- So: a source is now a page you paste, an item is a headline we saw on
-- it, and the interval between visits is per-source state that moves.
--
-- `interval_minutes` is the load-bearing column. It is the only thing in
-- this schema Athena sets about herself, and it is bounded in both
-- directions by the code that writes it (services/news/cadence.js):
-- never below NEWS_MIN_INTERVAL_MINUTES, never above a day. A fast
-- interval is not a state, it is a LOAN -- `interval_expires_at` is when
-- it falls back to `baseline_minutes`, which is arithmetic over how fast
-- the page has actually been changing, not an opinion. Without that
-- expiry a source that was interesting once would be visited every
-- fifteen minutes forever, which is both a cost and a rudeness.
--
-- `interval_reason` / `interval_set_by` exist so "why is she checking
-- this every 15 minutes?" has an answer a person can read, and so the
-- answer does not depend on a model having described itself honestly --
-- `news_poll` records what was actually observed at every visit.
--
-- `etag` / `last_modified` / `content_hash` make a visit to an unchanged
-- page cost nearly nothing, and `robots_*` records the site's own answer
-- to whether we should be reading that path at all. Both are politeness,
-- and politeness is what keeps a scraper welcome enough to keep working.
--
-- profile_id 0 is the house: sources seeded from the NEWS_FEEDS env var
-- that belong to no person and feed Athena's world memory. A real
-- profile_id is someone's own reading list. It is 0 rather than NULL
-- because the unique key below has to actually be unique, and MySQL lets
-- NULLs repeat in one.
-- =====================================================================

CREATE TABLE IF NOT EXISTS news_source (
  id              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  uuid            CHAR(36)         NOT NULL,
  -- 0 = the house (env-seeded). Otherwise the person who added it.
  profile_id      BIGINT           NOT NULL DEFAULT 0,
  -- The page as pasted, normalised (https, no fragment, no credentials).
  url             VARCHAR(500)     NOT NULL,
  -- sha1(url). The unique key: VARCHAR(500) under utf8mb4 is a wide
  -- index for something we only ever compare for equality.
  url_hash        CHAR(40)         NOT NULL,
  host            VARCHAR(255)     NOT NULL,
  -- What Athena calls it out loud. Defaults to the hostname.
  label           VARCHAR(120)     NULL,
  --   personal  this person's dashboard only
  --   world     also written into Athena's world memory, so she can talk
  --             about it. The person chooses; see the capability file.
  scope           VARCHAR(16)      NOT NULL DEFAULT 'world',
  enabled         TINYINT(1)       NOT NULL DEFAULT 1,

  -- How often we visit, right now, and where that number came from.
  interval_minutes    SMALLINT UNSIGNED NOT NULL DEFAULT 360,
  -- The resting rhythm this source decays back to. Arithmetic, not
  -- opinion: how fast the page has actually been changing.
  baseline_minutes    SMALLINT UNSIGNED NOT NULL DEFAULT 360,
  -- default | rules | athena | person
  interval_set_by     VARCHAR(16)  NOT NULL DEFAULT 'default',
  -- One line, shown to the person. Model-authored when set_by = athena:
  -- display only, never parsed back, never treated as an instruction.
  interval_reason     VARCHAR(300) NULL,
  -- When a borrowed fast interval returns to baseline. NULL = not borrowed.
  interval_expires_at DATETIME     NULL,

  next_check_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_checked_at DATETIME         NULL,
  -- The last visit that actually brought something new.
  last_changed_at DATETIME         NULL,

  -- Conditional GET, so an unchanged page costs a round trip and no body.
  etag            VARCHAR(255)     NULL,
  last_modified   VARCHAR(64)      NULL,
  content_hash    CHAR(40)         NULL,

  -- The site's own answer about whether we may read this path, cached.
  robots_allowed    TINYINT(1)     NULL,
  robots_delay_s    SMALLINT UNSIGNED NULL,
  robots_checked_at DATETIME       NULL,

  consecutive_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_error      VARCHAR(300)     NULL,
  created_at      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_news_source_uuid (uuid),
  -- One row per page per person. Pasting the same site twice is a no-op.
  UNIQUE KEY uq_news_source_page (profile_id, url_hash),
  -- The poller's only query: what is due?
  KEY idx_news_source_due (enabled, next_check_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A headline we saw on a page.
--
-- Kept rather than re-fetched, because "what is new since last time" is
-- the question the whole feature turns on -- it is what the dashboard
-- shows, and it is the signal the cadence decision reads. `first_seen_at`
-- is ours and trustworthy; `published_at` is the site's and often absent
-- or wrong, so nothing is ordered by it alone.
CREATE TABLE IF NOT EXISTS news_item (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id     BIGINT UNSIGNED NOT NULL,
  -- sha1 of the canonical link (or of the title when a page links nowhere).
  item_hash     CHAR(40)        NOT NULL,
  title         VARCHAR(300)    NOT NULL,
  url           VARCHAR(1000)   NULL,
  summary       VARCHAR(1000)   NULL,
  published_at  DATETIME        NULL,
  -- Where it sat on the page last time we looked. 1 is the lead story --
  -- a headline climbing to the top is a signal something is happening.
  slot          SMALLINT UNSIGNED NULL,
  first_seen_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_news_item (source_id, item_hash),
  KEY idx_news_item_fresh (source_id, first_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every visit, and what it changed. This is the audit trail behind the
-- interval: the deterministic record of what was observed, kept apart
-- from the model's account of it, for the same reason athena_nudge keeps
-- `facts` apart from `text`.
CREATE TABLE IF NOT EXISTS news_poll (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id      BIGINT UNSIGNED NOT NULL,
  polled_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- ok | unchanged | blocked | error
  status         VARCHAR(16)     NOT NULL,
  http_status    SMALLINT UNSIGNED NULL,
  items_found    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  items_new      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  duration_ms    INT UNSIGNED    NULL,
  interval_before SMALLINT UNSIGNED NULL,
  interval_after  SMALLINT UNSIGNED NULL,
  decided_by     VARCHAR(16)     NULL,
  note           VARCHAR(300)    NULL,
  PRIMARY KEY (id),
  KEY idx_news_poll_source (source_id, polled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
