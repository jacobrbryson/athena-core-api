-- Company-scoped review preferences and drafts. Secrets stay in user_credential.
CREATE TABLE IF NOT EXISTS athena_repository_review (
 profile_id BIGINT NOT NULL, workplace_uuid CHAR(36) NOT NULL,
 repository VARCHAR(200) NOT NULL, criteria TEXT NOT NULL,
 updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 PRIMARY KEY (profile_id, workplace_uuid, repository)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS athena_workspace_review_config (
 profile_id BIGINT NOT NULL, workplace_uuid CHAR(36) NOT NULL,
 credential_uuid CHAR(36) NOT NULL, provider VARCHAR(20) NOT NULL, model VARCHAR(100) NOT NULL,
 updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 PRIMARY KEY (profile_id, workplace_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS athena_pull_review_draft (
 uuid CHAR(36) NOT NULL PRIMARY KEY, profile_id BIGINT NOT NULL, workplace_uuid CHAR(36) NOT NULL,
 repository VARCHAR(200) NOT NULL, pull_number INT UNSIGNED NOT NULL,
 head_sha CHAR(40) NOT NULL, base_sha CHAR(40) NOT NULL,
 criteria TEXT NOT NULL, credential_uuid CHAR(36) NOT NULL,
 provider VARCHAR(20) NOT NULL, model VARCHAR(100) NOT NULL,
 state VARCHAR(20) NOT NULL, active_slot TINYINT NULL,
 body MEDIUMTEXT NULL, usage_json JSON NULL, warnings JSON NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY one_review_in_flight (profile_id, workplace_uuid, repository, pull_number, active_slot),
 KEY review_draft_owner (profile_id, workplace_uuid, repository, pull_number, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
