-- Capability-eval scores per endpoint, model and suite (services/llm/evalStore.js).
-- The model router reads the latest rows to decide whether a local model has
-- earned the first answer for a task; the Models tab charts them over time.
CREATE TABLE IF NOT EXISTS llm_eval_result (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  endpoint_id     VARCHAR(64)     NOT NULL,
  tier            VARCHAR(16)     NOT NULL,   -- orcwood | frontier
  model           VARCHAR(120)    NULL,
  suite           VARCHAR(32)     NOT NULL,   -- reply-contract | recall-honesty | extraction | vision
  passed          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  total           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  avg_latency_ms  INT UNSIGNED    NULL,
  source          VARCHAR(16)     NOT NULL DEFAULT 'nightly', -- nightly | manual
  PRIMARY KEY (id),
  KEY idx_llm_eval_result_lookup (endpoint_id, suite, created_at),
  KEY idx_llm_eval_result_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
