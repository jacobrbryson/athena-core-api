-- =====================================================================
-- 0082_security_media.up.sql
-- Camera images and clips kept from Property -> Security.
-- See src/services/securityMedia.js and docs/capabilities/eufy-security.md.
--
-- Every fresh image an authorized adult requests is kept, and every clip
-- they record. Nothing is captured on its own: a row exists only because a
-- person pressed a button. The bytes live in the private bucket
-- `athena-security-media` (no public access, no lifecycle rule); media_uri is
-- the gs:// path and is never sent to the app.
--
-- important marks what someone chose to keep (clips start important). The
-- media is household-wide: every authorized adult sees every row, and
-- captured_by records who asked for it.
--
-- Conventions match 0001-0081: no enforced FKs.
-- =====================================================================

CREATE TABLE IF NOT EXISTS athena_security_media (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid          CHAR(36)        NOT NULL,
  captured_by   BIGINT          NOT NULL,  -- profile.id of the adult who asked
  device_serial VARCHAR(40)     NOT NULL,
  device_name   VARCHAR(120)    NULL,
  media_type    VARCHAR(8)      NOT NULL,  -- image | clip
  content_type  VARCHAR(32)     NOT NULL,  -- image/jpeg | video/mp4
  bytes         INT UNSIGNED    NOT NULL,
  duration_s    SMALLINT        NULL,      -- clips only, the length asked for
  media_uri     VARCHAR(512)    NOT NULL,  -- gs://bucket/path
  important     TINYINT(1)      NOT NULL DEFAULT 0,
  captured_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_athena_security_media_uuid (uuid),
  KEY idx_athena_security_media_recent (captured_at),
  KEY idx_athena_security_media_device (device_serial, captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
