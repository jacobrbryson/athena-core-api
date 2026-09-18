-- Reverse of 0028_device_push.
--
-- Drops every device's push registration; each device must re-register
-- before it can be reached again. It does not un-send anything.
ALTER TABLE athena_initiative_pref DROP COLUMN push_enabled;
ALTER TABLE athena_nudge DROP COLUMN pushed_at;
ALTER TABLE paired_device
  DROP COLUMN push_failed_at,
  DROP COLUMN push_failures,
  DROP COLUMN push_registered_at,
  DROP COLUMN push_token_enc,
  DROP COLUMN push_provider;
