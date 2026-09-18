const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");

/**
 * The name to put in front of a line when more than one person is talking.
 *
 * Prefers what the family chose to call someone over whatever Google put on
 * the account, and returns it as three indexed point-lookups rather than a
 * join — a profile can belong to several families, and joining would fan each
 * message row out into one row per membership.
 */
const SPEAKER_NAME_SQL = `COALESCE(
	(SELECT fm.display_name FROM family_members fm
	   WHERE fm.profile_id = r.profile_id AND fm.deleted_at IS NULL
	     AND fm.display_name IS NOT NULL LIMIT 1),
	(SELECT cp.display_name FROM child_profiles cp
	   WHERE cp.profile_id = r.profile_id AND cp.deleted_at IS NULL LIMIT 1),
	(SELECT p.full_name FROM profile p WHERE p.id = r.profile_id LIMIT 1)
)`;

/**
 * Messages a viewer is entitled to see, as a WHERE fragment.
 *
 * Presence is the disclosure boundary. Everything said in a shared session was
 * heard by everyone who was in it at the time, so showing them the transcript
 * discloses nothing they did not already witness — but someone who joined late,
 * or stepped out, must not be able to read the stretch they were absent for.
 *
 * Fail-closed by construction: no span means no messages. That is why every
 * path that binds a session to a profile also opens a span, and why the 0030
 * migration backfills one for every session that already had an owner.
 */
const VISIBLE_TO_VIEWER_SQL = `EXISTS (
	SELECT 1 FROM session_participant sp
	 WHERE sp.session_id = m.session_id
	   AND sp.profile_id = ?
	   AND m.created_at >= sp.joined_at
	   AND (sp.left_at IS NULL OR m.created_at <= sp.left_at)
)`;

/** First name only: "Jacob:" reads like a person, "Jacob Bryson:" like a row. */
function firstName(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().split(/\s+/)[0].slice(0, 40)
    : null;
}

function shape(row) {
  return {
    uuid: row.uuid,
    text: row.text,
    created_at: row.created_at,
    is_human: row.is_human,
    mode: row.mode,
    // Who said it. NULL for Athena's own turns, and for human turns written
    // before sessions could hold more than one person.
    profile_id: row.profile_id ?? null,
    speaker: firstName(row.speaker_name),
  };
}

/**
 * @param {number} sessionId
 * @param {boolean} isHuman
 * @param {string} message
 * @param {string|null} mode
 * @param {number|null} profileId who spoke. Null for Athena, and for an
 *   anonymous session where there is no profile to name.
 */
async function addMessage(
  sessionId,
  isHuman,
  message,
  mode = null,
  profileId = null,
) {
  const uuid = uuidv4();
  const speaker =
    isHuman && Number.isFinite(Number(profileId)) ? Number(profileId) : null;

  await pool.query(
    "INSERT INTO message (session_id, uuid, is_human, profile_id, text, mode) VALUES (?, ?, ?, ?, ?, ?)",
    [sessionId, uuid, isHuman, speaker, message, mode],
  );

  return uuid;
}

/**
 * The most recent 100 messages, oldest -> newest. Selecting the newest page
 * and re-sorting matters: a plain `ASC LIMIT 100` returns a long session's
 * FIRST 100 messages, so replies stopped appearing after message 100.
 *
 * `viewerProfileId` restricts the result to what that person was present for.
 * Null means no restriction, which is correct only for an anonymous session —
 * there is no identity to filter on and the caller was authorized by IP.
 */
async function getMessages(sessionId, viewerProfileId = null) {
  const viewer = Number.isFinite(Number(viewerProfileId))
    ? Number(viewerProfileId)
    : null;
  const [messages] = await pool.query(
    `SELECT r.uuid, r.text, r.created_at, r.is_human, r.mode, r.profile_id,
		        ${SPEAKER_NAME_SQL} AS speaker_name
		 FROM (
       SELECT m.uuid, m.text, m.created_at, m.is_human, m.mode, m.profile_id
       FROM message m
       WHERE m.session_id = ?${viewer !== null ? ` AND ${VISIBLE_TO_VIEWER_SQL}` : ""}
       ORDER BY m.created_at DESC LIMIT 100
     ) r ORDER BY r.created_at ASC;`,
    viewer !== null ? [sessionId, viewer] : [sessionId],
  );

  return messages.map(shape);
}

/** Messages strictly newer than `since` (a DATETIME), oldest -> newest. */
async function getMessagesSince(sessionId, since, limit = 40) {
  const [messages] = await pool.query(
    `SELECT m.uuid, m.text, m.created_at, m.is_human, m.profile_id FROM message m
     WHERE m.session_id = ?${since ? " AND m.created_at > ?" : ""}
     ORDER BY m.created_at ASC LIMIT ?;`,
    since ? [sessionId, since, limit] : [sessionId, limit],
  );
  return messages;
}

module.exports = {
  addMessage,
  getMessages,
  getMessagesSince,
};
