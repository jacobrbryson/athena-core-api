-- Nightly self-review reports (src/jobs/nightly.js). One row per local day:
-- the raw metrics + eval results, the structured plan, and the rendered
-- Markdown. Yesterday's plan is fed into tonight's review so Athena can say
-- whether each item actually improved.
CREATE TABLE IF NOT EXISTS self_review_report (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_date  DATE            NOT NULL,
  metrics      JSON            NOT NULL,
  evals        JSON            NULL,
  plan         JSON            NULL,
  markdown     MEDIUMTEXT      NOT NULL,
  served_by    VARCHAR(80)     NULL,   -- which model wrote the plan
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_self_review_date (report_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
