-- =====================================================================
-- 0057_websites.up.sql
-- Websites: the sites the person manages, and a daily snapshot of how each
-- one is doing, read from Google Search Console and Analytics (GA4).
-- Read-only; see docs/capabilities/websites.md.
--
-- athena_site holds what the person typed (the domain, which Search Console
-- property and GA4 property belong to it). athena_site_snapshot is what Google
-- said, one row per site per day per source, kept so a week can be compared
-- with the one before it and a trend can be told without calling Google.
--
-- Conventions match 0001-0056: no enforced FKs (integrity in the service).
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_site (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid            CHAR(36)        NOT NULL,
  profile_id      BIGINT          NOT NULL,
  domain          VARCHAR(190)    NOT NULL,   -- "orcwood.com", no scheme or www
  label           VARCHAR(120)    NULL,       -- "Orcwood Games"
  search_site     VARCHAR(255)    NULL,       -- "sc-domain:orcwood.com" or a URL prefix
  ga_property     VARCHAR(20)     NULL,       -- GA4 numeric property id
  notes           VARCHAR(500)    NULL,
  last_checked_at DATETIME        NULL,
  last_error      VARCHAR(255)    NULL,       -- what stopped the last read, in words
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_site_uuid (uuid),
  UNIQUE KEY uq_athena_site_domain (profile_id, domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS athena_site_snapshot (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id     BIGINT UNSIGNED NOT NULL,
  taken_on    DATE            NOT NULL,
  source      VARCHAR(20)     NOT NULL,       -- search | analytics
  data        JSON            NOT NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_site_snapshot (site_id, source, taken_on),
  KEY idx_athena_site_snapshot_latest (site_id, source, taken_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
