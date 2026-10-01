-- 0049_email_sync.down.sql
DROP TABLE IF EXISTS email_sync_state;
-- Rows marked 'gone' / 'pending' are left as they are; the older code shows
-- 'gone' nowhere (it reads status = 'new') and treats 'pending' as unknown.
