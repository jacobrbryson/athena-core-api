-- Disposable, encrypted read data. Never stores tokens or access decisions.
CREATE TABLE IF NOT EXISTS read_cache_scope (
  profile_id BIGINT NOT NULL,
  namespace VARCHAR(64) NOT NULL,
  generation VARCHAR(36) NOT NULL,
  PRIMARY KEY (profile_id, namespace)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS read_cache (
  cache_key CHAR(64) NOT NULL,
  profile_id BIGINT NOT NULL,
  namespace VARCHAR(64) NOT NULL,
  payload MEDIUMTEXT NOT NULL,
  expires_ms BIGINT NOT NULL,
  PRIMARY KEY (cache_key),
  KEY idx_read_cache_expiry (expires_ms),
  KEY idx_read_cache_scope (profile_id, namespace)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
