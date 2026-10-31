-- A review runs in the background, one pass per Cloud Task. Progress survives
-- between passes here; the diff itself is re-read from GitHub, never stored.
ALTER TABLE athena_pull_review_draft
 ADD COLUMN pull_title VARCHAR(300) NULL,
 ADD COLUMN pass_index INT UNSIGNED NOT NULL DEFAULT 0,
 ADD COLUMN pass_total INT UNSIGNED NULL,
 ADD COLUMN pass_claimed TINYINT NOT NULL DEFAULT 0,
 ADD COLUMN pass_notes JSON NULL,
 ADD COLUMN failure VARCHAR(200) NULL,
 ADD COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);
