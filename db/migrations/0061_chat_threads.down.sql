ALTER TABLE message DROP INDEX message_event_key, DROP INDEX message_thread,
  DROP INDEX message_action, DROP COLUMN reply_to_uuid, DROP COLUMN action_uuid,
  DROP COLUMN private_profile_id, DROP COLUMN event_key;
