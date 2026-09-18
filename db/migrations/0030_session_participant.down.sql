-- Reverses 0030_session_participant.
--
-- Dropping the table returns authorization to owner-equality, and dropping
-- the column returns the transcript to a single unnamed human. Both are
-- losses of information rather than of correctness: sessions keep working,
-- shared ones simply stop being shareable again.
ALTER TABLE message
  DROP KEY idx_message_profile,
  DROP COLUMN profile_id;

DROP TABLE IF EXISTS session_participant;
