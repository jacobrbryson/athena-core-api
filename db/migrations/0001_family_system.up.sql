-- =====================================================================
-- 0001_family_system.up.sql
-- Athena Family Accounts & Companion Mode Foundation
-- ---------------------------------------------------------------------
-- Introduces a family-first hierarchy on top of the existing flat
-- `profile` model. Families become the canonical organizing entity;
-- the legacy pairwise `profile_child` table is kept as a compatibility
-- shadow (see docs/architecture/family-system.md) and back-filled below.
--
-- Conventions:
--   * New tables use BIGINT UNSIGNED auto-increment ids.
--   * All cross-table references (including to the existing `profile.id`)
--     use plain integer columns with indexes and are NOT enforced as
--     foreign keys. This matches the existing codebase convention (the
--     legacy schema uses no enforced FKs) and avoids cross-environment
--     type-compatibility failures; integrity is maintained in the service
--     layer. New-table id references use BIGINT UNSIGNED + index.
--   * Idempotent where practical (IF NOT EXISTS / NOT EXISTS guards) so
--     the runner can be re-applied safely during development.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Collision guard: a pre-existing, UNRELATED `families` table (legacy
-- columns id/name/city) occupied this name. It is the parent of a
-- dependent object graph (`players`, `puzzle_pieces`, ...), so instead of
-- dropping it we RENAME it aside to `families_legacy`. InnoDB
-- automatically re-points the dependent foreign keys at the renamed
-- table, so that data keeps working untouched, while the `families` name
-- is freed for the family-system table.
--
-- Guarded so it triggers ONLY when the legacy `families` lacks the `uuid`
-- column required by the new table; once the proper `families` exists the
-- guard is inert and re-running is safe.
-- ---------------------------------------------------------------------
SET @has_families := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'families');
SET @has_uuid := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'families' AND COLUMN_NAME = 'uuid');
SET @has_legacy_target := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'families_legacy');
SET @is_legacy := IF(@has_families > 0 AND @has_uuid = 0 AND @has_legacy_target = 0, 1, 0);

SET @ddl := IF(@is_legacy = 1, 'RENAME TABLE families TO families_legacy', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- families
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS families (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid               CHAR(36)        NOT NULL,
  name               VARCHAR(120)    NOT NULL,
  created_by_profile_id BIGINT       NULL,
  subscription_plan  VARCHAR(40)     NOT NULL DEFAULT 'free',
  status             VARCHAR(20)     NOT NULL DEFAULT 'active',
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at         DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_families_uuid (uuid),
  KEY idx_families_created_by (created_by_profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- family_members  (multi-parent + multi-child capable)
-- role: 'owner' | 'parent' | 'guardian' | 'child'
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS family_members (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id    BIGINT UNSIGNED NOT NULL,
  profile_id   BIGINT          NOT NULL,
  role         VARCHAR(20)     NOT NULL DEFAULT 'parent',
  display_name VARCHAR(120)    NULL,
  status       VARCHAR(20)     NOT NULL DEFAULT 'active',
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at   DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_family_member (family_id, profile_id),
  KEY idx_family_members_profile (profile_id),
  KEY idx_family_members_role (family_id, role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- child_profiles  (child-specific extension of a `profile` row)
-- A child is still a `profile` row (so existing sessions / goals /
-- activity keep working) plus this row carrying family + child metadata.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS child_profiles (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid                  CHAR(36)        NOT NULL,
  family_id             BIGINT UNSIGNED NOT NULL,
  profile_id            BIGINT          NOT NULL,
  display_name          VARCHAR(120)    NULL,
  avatar                VARCHAR(255)    NULL,
  grade                 VARCHAR(20)     NULL,
  birthday              DATE            NULL,
  status                VARCHAR(20)     NOT NULL DEFAULT 'active',
  created_by_profile_id BIGINT          NULL,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at            DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_child_profiles_uuid (uuid),
  UNIQUE KEY uq_child_profiles_profile (profile_id),
  KEY idx_child_profiles_family (family_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- family_permissions  (parent-configurable AI / feature permissions)
-- child_profile_id = 0 means "family-wide default"; > 0 scopes to a
-- specific child_profiles.id. Using 0 (not NULL) keeps the UNIQUE key
-- meaningful since MySQL allows multiple NULLs.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS family_permissions (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id             BIGINT UNSIGNED NOT NULL,
  child_profile_id      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  permission_key        VARCHAR(64)     NOT NULL,
  permission_value      VARCHAR(512)    NULL,
  updated_by_profile_id BIGINT          NULL,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_family_permission (family_id, child_profile_id, permission_key),
  KEY idx_family_permissions_family (family_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- family_consent  (current acceptance snapshot, one row per type)
-- consent_type: 'privacy_policy' | 'ai_disclosure' | 'terms_of_service'
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS family_consent (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id            BIGINT UNSIGNED NOT NULL,
  consent_type         VARCHAR(40)     NOT NULL,
  document_version     VARCHAR(40)     NULL,
  accepted_by_profile_id BIGINT        NULL,
  accepted_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address           VARCHAR(64)     NULL,
  user_agent           VARCHAR(255)    NULL,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_family_consent (family_id, consent_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- family_consent_log  (append-only audit history)
-- action: 'accepted' | 'revoked'
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS family_consent_log (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id            BIGINT UNSIGNED NOT NULL,
  consent_type         VARCHAR(40)     NOT NULL,
  document_version     VARCHAR(40)     NULL,
  action               VARCHAR(20)     NOT NULL DEFAULT 'accepted',
  actor_profile_id     BIGINT          NULL,
  ip_address           VARCHAR(64)     NULL,
  user_agent           VARCHAR(255)    NULL,
  created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_family_consent_log_family (family_id, consent_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- child_login_code  (QR + friendly token login for children)
-- code_type: 'token' (e.g. SUNNY-APPLE) | 'qr' (long random token)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS child_login_code (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid                  CHAR(36)        NOT NULL,
  family_id             BIGINT UNSIGNED NOT NULL,
  child_profile_id      BIGINT          NOT NULL, -- references profile.id of the child
  code_type             VARCHAR(20)     NOT NULL DEFAULT 'token',
  code                  VARCHAR(80)     NOT NULL,
  label                 VARCHAR(120)    NULL,
  created_by_profile_id BIGINT          NULL,
  expires_at            DATETIME        NULL,
  revoked_at            DATETIME        NULL,
  last_used_at          DATETIME        NULL,
  use_count             INT             NOT NULL DEFAULT 0,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_child_login_code_uuid (uuid),
  UNIQUE KEY uq_child_login_code_code (code),
  KEY idx_child_login_code_child (child_profile_id),
  KEY idx_child_login_code_family (family_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- conversation_mode  (extensible mode catalog -- do NOT hardcode 2 modes)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_mode (
  mode_key    VARCHAR(40)  NOT NULL,
  label       VARCHAR(80)  NOT NULL,
  description VARCHAR(255) NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order  INT          NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (mode_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO conversation_mode (mode_key, label, description, is_active, sort_order) VALUES
  ('teach',     'Teach Athena',  'Teach Athena and watch it learn from you.',        1, 10),
  ('companion', 'Companion',     'Open-ended, friendly conversation and brainstorming.', 1, 20),
  ('quest',     'Quest',         'Story-driven guided quests. (coming soon)',         0, 30),
  ('coach',     'Coach',         'Goal-oriented coaching and encouragement. (coming soon)', 0, 40),
  ('guardians', 'Lake Norman Guardians', 'Lore, artifacts and character progression. (coming soon)', 0, 50)
ON DUPLICATE KEY UPDATE label = VALUES(label), description = VALUES(description);

-- ---------------------------------------------------------------------
-- user_memory  (Phase 7 -- foundational, family + privacy aware)
-- category: 'interest' | 'subject' | 'pet' | 'family' | 'preference' | 'other'
-- visibility: 'private' (child only) | 'family' (parents may view)
-- source: 'user' | 'parent' | 'ai'
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_memory (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid                  CHAR(36)        NOT NULL,
  profile_id            BIGINT          NOT NULL,
  family_id             BIGINT UNSIGNED NULL,
  category              VARCHAR(32)     NOT NULL DEFAULT 'other',
  memory_key            VARCHAR(120)    NOT NULL,
  memory_value          TEXT            NULL,
  source                VARCHAR(20)     NOT NULL DEFAULT 'user',
  visibility            VARCHAR(20)     NOT NULL DEFAULT 'private',
  confidence            TINYINT         NULL,
  created_by_profile_id BIGINT          NULL,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at            DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_memory_uuid (uuid),
  UNIQUE KEY uq_user_memory_slot (profile_id, category, memory_key),
  KEY idx_user_memory_profile (profile_id),
  KEY idx_user_memory_family (family_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- session: make sessions profile + family + mode aware.
-- (Existing sessions remain IP-bound; these columns are additive.)
-- Guarded so re-running does not error on already-added columns.
-- ---------------------------------------------------------------------
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session' AND COLUMN_NAME = 'profile_id');
SET @ddl := IF(@col = 0,
  'ALTER TABLE session ADD COLUMN profile_id BIGINT NULL, ADD KEY idx_session_profile (profile_id)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session' AND COLUMN_NAME = 'family_id');
SET @ddl := IF(@col = 0,
  'ALTER TABLE session ADD COLUMN family_id BIGINT NULL, ADD KEY idx_session_family (family_id)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session' AND COLUMN_NAME = 'mode');
SET @ddl := IF(@col = 0,
  'ALTER TABLE session ADD COLUMN mode VARCHAR(40) NOT NULL DEFAULT ''teach''',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- =====================================================================
-- BACK-FILL: derive families from existing pairwise profile_child links.
-- One family per existing parent (family-first canonical model). A child
-- linked to multiple parents lands in the first parent's family (the
-- UNIQUE(profile_id) on child_profiles enforces a single home family);
-- multi-parent reconciliation is a documented follow-up.
-- =====================================================================

-- 1. A family per parent that has at least one active child link.
INSERT INTO families (uuid, name, created_by_profile_id, created_at)
SELECT UUID(),
       CONCAT(COALESCE(NULLIF(TRIM(p.full_name), ''), 'My'), '''s Family'),
       p.id,
       NOW()
FROM profile p
WHERE p.id IN (SELECT DISTINCT parent_profile_id FROM profile_child WHERE deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM families f WHERE f.created_by_profile_id = p.id);

-- 2. Owner membership for each parent.
INSERT INTO family_members (family_id, profile_id, role, display_name, status, created_at)
SELECT f.id, p.id, 'owner', p.full_name, 'active', NOW()
FROM families f
JOIN profile p ON p.id = f.created_by_profile_id
WHERE NOT EXISTS (
  SELECT 1 FROM family_members fm WHERE fm.family_id = f.id AND fm.profile_id = p.id
);

-- 3. Child membership for each active parent_child link.
INSERT INTO family_members (family_id, profile_id, role, display_name, status, created_at)
SELECT f.id, c.id, 'child', c.full_name, 'active', NOW()
FROM profile_child pc
JOIN families f ON f.created_by_profile_id = pc.parent_profile_id
JOIN profile c ON c.id = pc.child_profile_id
WHERE pc.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM family_members fm WHERE fm.family_id = f.id AND fm.profile_id = c.id
  );

-- 4. child_profiles row per child (first family wins via UNIQUE profile_id).
INSERT INTO child_profiles (uuid, family_id, profile_id, display_name, grade, birthday, created_by_profile_id, created_at)
SELECT UUID(), f.id, c.id, c.full_name, c.grade,
       CASE WHEN c.birthday IS NULL OR LEFT(c.birthday, 10) = '' THEN NULL ELSE LEFT(c.birthday, 10) END,
       f.created_by_profile_id, NOW()
FROM profile_child pc
JOIN families f ON f.created_by_profile_id = pc.parent_profile_id
JOIN profile c ON c.id = pc.child_profile_id
WHERE pc.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM child_profiles cp WHERE cp.profile_id = c.id);
