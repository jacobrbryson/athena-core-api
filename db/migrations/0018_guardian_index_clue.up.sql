-- Mission 3: one resumable clue-decryption assignment per Guardian.
-- The target is revalidated against the shared found-card index before reveal.

CREATE TABLE IF NOT EXISTS guardian_index_clue (
  mission_key     VARCHAR(80) NOT NULL,
  adventure_key   VARCHAR(80) NOT NULL,
  guardian_id     VARCHAR(8)  NOT NULL,
  target_entry_id VARCHAR(16) NOT NULL,
  status          VARCHAR(12) NOT NULL DEFAULT 'pending',
  issued_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revealed_at     DATETIME    NULL,
  PRIMARY KEY (mission_key, adventure_key, guardian_id),
  KEY idx_index_clue_target (mission_key, adventure_key, target_entry_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
