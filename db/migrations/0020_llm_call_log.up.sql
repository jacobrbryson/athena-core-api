-- Per-call model telemetry written by services/llm/telemetry.js and read by
-- the nightly self-review (jobs/nightly-review.js).
CREATE TABLE IF NOT EXISTS llm_call_log (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  task         VARCHAR(24)     NOT NULL,
  endpoint_id  VARCHAR(64)     NOT NULL,
  tier         VARCHAR(16)     NOT NULL,   -- device | orcwood | frontier
  model        VARCHAR(120)    NULL,
  outcome      VARCHAR(12)     NOT NULL,   -- ok | error | invalid
  latency_ms   INT UNSIGNED    NOT NULL DEFAULT 0,
  attempt      TINYINT UNSIGNED NOT NULL DEFAULT 0, -- 0 = first choice; >0 = a fallback served it
  input_chars  INT UNSIGNED    NOT NULL DEFAULT 0,
  output_chars INT UNSIGNED    NOT NULL DEFAULT 0,
  error        VARCHAR(300)    NULL,
  audience     VARCHAR(12)     NULL,       -- adult | child
  PRIMARY KEY (id),
  KEY idx_llm_call_log_time (created_at),
  KEY idx_llm_call_log_task (task, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
