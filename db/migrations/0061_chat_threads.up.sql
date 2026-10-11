-- Links are conversation context only; they never authorize an action.
ALTER TABLE message
  ADD COLUMN reply_to_uuid VARCHAR(36) NULL,
  ADD COLUMN action_uuid VARCHAR(36) NULL,
  ADD COLUMN private_profile_id BIGINT NULL,
  ADD COLUMN event_key VARCHAR(191) NULL,
  ADD UNIQUE KEY message_event_key (event_key),
  ADD KEY message_thread (session_id, reply_to_uuid),
  ADD KEY message_action (action_uuid);

-- Recover existing cards next to the first Athena reply following proposal.
UPDATE message m JOIN athena_action a ON a.session_id = m.session_id
SET m.action_uuid = a.uuid
WHERE m.action_uuid IS NULL AND m.uuid = (
  SELECT candidate.uuid FROM (SELECT uuid, session_id, is_human, created_at FROM message) candidate
  WHERE candidate.session_id = a.session_id AND candidate.is_human = 0
    AND candidate.created_at >= a.created_at
    AND candidate.created_at <= DATE_ADD(a.created_at, INTERVAL 2 MINUTE)
  ORDER BY candidate.created_at, candidate.uuid LIMIT 1
);
