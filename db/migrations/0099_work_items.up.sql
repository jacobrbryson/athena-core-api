-- Client work is distinct from Athena self-repair. Secrets remain in user_credential.
CREATE TABLE IF NOT EXISTS athena_work_environment (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 uuid CHAR(36) NOT NULL UNIQUE, profile_id BIGINT NOT NULL,
 workplace_uuid CHAR(36) NOT NULL, name VARCHAR(120) NOT NULL,
 config JSON NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY work_environment_owner(profile_id, workplace_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS athena_work_run (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 uuid CHAR(36) NOT NULL UNIQUE, profile_id BIGINT NOT NULL,
 environment_uuid CHAR(36) NOT NULL, workplace_uuid CHAR(36) NOT NULL,
 issue_json JSON NOT NULL, config_json JSON NOT NULL,
 phase VARCHAR(32) NOT NULL DEFAULT 'draft',
 plan MEDIUMTEXT NULL, plan_hash CHAR(64) NULL,
 approval_uuid CHAR(36) NULL, implementation_uuid CHAR(36) NULL,
 lease_token CHAR(64) NULL, lease_until DATETIME NULL,
 runner_uuid CHAR(36) NULL, checkpoint JSON NULL,
 comment_id VARCHAR(100) NULL, comment_state VARCHAR(20) NULL,
 reason VARCHAR(500) NULL, tokens_used BIGINT NOT NULL DEFAULT 0,
 tokens_reserved BIGINT NOT NULL DEFAULT 0, model_steps INT NOT NULL DEFAULT 0,
 notified_at DATETIME NULL, notification_claim DATETIME NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 KEY work_run_owner(profile_id, created_at), KEY work_run_queue(phase, lease_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS athena_work_event (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 run_uuid CHAR(36) NOT NULL, kind VARCHAR(40) NOT NULL, detail JSON NOT NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY work_event_run(run_uuid, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS athena_work_usage (
 uuid CHAR(36) NOT NULL PRIMARY KEY, run_uuid CHAR(36) NOT NULL,
 provider VARCHAR(20) NOT NULL, model VARCHAR(120) NOT NULL,
 payer VARCHAR(20) NOT NULL, operation VARCHAR(30) NOT NULL,
 credential_uuid CHAR(36) NULL, state VARCHAR(20) NOT NULL,
 reserved_tokens INT NOT NULL DEFAULT 0, usage_json JSON NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY work_usage_run(run_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS athena_work_artifact (
 uuid CHAR(36) NOT NULL PRIMARY KEY, run_uuid CHAR(36) NOT NULL,
 name VARCHAR(120) NOT NULL, mime VARCHAR(80) NOT NULL,
 object_name VARCHAR(255) NOT NULL, sha256 CHAR(64) NOT NULL,
 bytes BIGINT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY work_artifact_run(run_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
