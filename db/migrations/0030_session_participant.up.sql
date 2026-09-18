-- =====================================================================
-- 0030_session_participant.up.sql
-- A conversation that outlives the account that started it.
-- ---------------------------------------------------------------------
-- Until now a session belonged to exactly one profile. `session.profile_id`
-- was set once and never reassigned (the `profile_id IS NULL` guard in
-- bindSessionProfile), and getAuthorizedSession refused anyone whose proven
-- profile did not equal it.
--
-- That is correct for one person on one device, and wrong for a room. When
-- two guardians share a screen and one switches accounts, the second is
-- refused the session and the client's only remaining move is to start a
-- new one -- which severs the transcript. Athena loses the thread of a
-- conversation she was present for the whole time, mid-sentence.
--
-- The fix is membership instead of ownership. `session.profile_id` stays
-- exactly as it is -- who STARTED the conversation, and every existing
-- reader of that column keeps working. This table records everyone who has
-- been part of it since.
--
-- WHY THIS IS NOT A SESSION-HIJACKING PATH. Relaxing the equality check
-- would be one, if membership could be claimed. It cannot: a row here is
-- only ever written for a caller who has already proven that profile with a
-- signed token, and only when they share an active family with the person
-- whose session it is (services/sessionParticipant.js). Knowing a session
-- uuid still gets you nothing. Widening this check was directed by the
-- owner; see the root AGENTS.md on who may authorize access changes.
--
-- SPANS, NOT A FLAG. `left_at` closes a span rather than deleting the row,
-- and a person may have several. Presence is the disclosure boundary: what
-- was said in the room was heard by everyone in the room, so a shared
-- transcript discloses nothing new -- but someone who stepped out must not
-- be able to scroll back into the part they were absent for. That is a
-- range test, and it needs the ranges kept.
-- =====================================================================

CREATE TABLE IF NOT EXISTS session_participant (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT   NOT NULL,
  profile_id BIGINT   NOT NULL,
  -- How this person came to be in the conversation. 'owner' is the profile
  -- the session was created for (backfilled below); 'joined' is someone who
  -- authenticated into an existing one.
  via        VARCHAR(20) NOT NULL DEFAULT 'joined',
  joined_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL means still present. A closed span is history, never deleted --
  -- the transcript filter reads it.
  left_at    DATETIME NULL,
  PRIMARY KEY (id),
  -- One OPEN span per person per session. Deliberately not a unique key on
  -- (session_id, profile_id): leaving and coming back must produce a second
  -- span, or the gap they were absent for disappears. Re-joining while
  -- already present is an idempotent no-op in code.
  KEY idx_participant_session (session_id, profile_id, left_at),
  KEY idx_participant_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who actually said it.
--
-- `message.is_human` is a boolean, which was enough while every human in a
-- session was the same human. With two, the transcript can no longer say
-- which of them spoke, and prompt.js renders both as one `user` role -- so
-- Athena reads a conversation between two people as one person talking to
-- themselves and confidently attributes one guardian's words to the other.
--
-- NULL is correct for Athena's own messages, and for every human message
-- written before this column existed (one speaker, so the session's owner
-- is the answer -- resolved at render time rather than guessed into rows).
ALTER TABLE message
  ADD COLUMN profile_id BIGINT NULL AFTER is_human,
  ADD KEY idx_message_profile (profile_id);

-- Backfill: every already-bound session gets its owner as a participant,
-- present from the moment the session was created.
--
-- This is what keeps the transcript filter fail-closed. No span means no
-- visible messages, which is the right default for a stranger and the wrong
-- one for the person whose conversation it is -- so no bound session is
-- left without one.
INSERT INTO session_participant (session_id, profile_id, via, joined_at)
SELECT s.id, s.profile_id, 'owner', s.created_at
FROM session s
WHERE s.profile_id IS NOT NULL;
