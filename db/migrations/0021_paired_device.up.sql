-- Paired devices (Athena on Android phones / car head units).
--
-- Phones hop between Wi-Fi and cellular constantly, so the IP-pinned session
-- JWTs used by the web apps don't work for them. A device instead redeems a
-- short-lived pairing code (shown in the Companion app) for a long-lived
-- device token. Only the token's hash is stored, every request re-checks this
-- table, and the owner can revoke a device at any time.
CREATE TABLE IF NOT EXISTS paired_device (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid           CHAR(36)        NOT NULL,
  profile_id     BIGINT          NOT NULL,
  name           VARCHAR(80)     NOT NULL,
  platform       VARCHAR(24)     NOT NULL DEFAULT 'android', -- android | web | car
  token_hash     CHAR(64)        NULL,       -- sha256 of the device token (NULL until paired)
  pairing_code_hash CHAR(64)     NULL,       -- sha256 of the pending one-time pairing code
  pairing_expires_at DATETIME    NULL,
  capabilities   JSON            NULL,       -- last /llm/device-report (runtimes, RAM, installed models)
  last_seen_at   DATETIME        NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at     DATETIME        NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_paired_device_uuid (uuid),
  UNIQUE KEY uq_paired_device_token (token_hash),
  UNIQUE KEY uq_paired_device_code (pairing_code_hash),
  KEY idx_paired_device_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
