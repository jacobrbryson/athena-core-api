-- A PR with SQL files can be tried on a disposable database by the owner's
-- local work runner. Only the outcome is kept here, never the backup.
ALTER TABLE athena_pull_review_draft
 ADD COLUMN db_check_state VARCHAR(12) NULL,
 ADD COLUMN db_check_runner CHAR(36) NULL,
 ADD COLUMN db_check_result JSON NULL;
