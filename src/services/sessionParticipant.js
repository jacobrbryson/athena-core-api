/**
 * Who is part of this conversation.
 *
 * A session used to belong to one profile: `session.profile_id`, set once,
 * never reassigned. That is right for one person on one device and wrong for
 * a room. Two guardians sharing a screen, one switching accounts, produced a
 * refused session and a brand-new transcript — Athena losing the thread of a
 * conversation she had been present for the whole time.
 *
 * So `session.profile_id` keeps its meaning — who STARTED it — and this module
 * owns the separate question of who has been part of it since.
 *
 * ## The rule that keeps this from being a hijack path
 *
 * Authorization by equality was doing real work: knowing a session uuid got
 * you nothing without proving you were its owner. Membership must be at least
 * as strong, so a participant row is written only when BOTH hold:
 *
 *   1. The caller has already proven that profile with a signed token
 *      (`resolveCallerProfileId` — never a body or query field), and
 *   2. they share an active family with the person whose session it is, in an
 *      adult role.
 *
 * Neither is inferable from the uuid. An anonymous session — no family, no
 * owner — can never be joined at all, because there is nothing to check
 * against and the safe answer to "may this stranger read it?" is no.
 *
 * Widening a session access check is the kind of change the root `AGENTS.md`
 * reserves to the owner. This one was owner-directed.
 *
 * ## Admission starts at the beginning of the conversation, not at the switch
 *
 * A joiner's span opens at the SESSION's creation, not at the moment they
 * authenticated, and that is the decision the whole feature rests on.
 *
 * The justification for sharing a transcript is co-presence: what was said in
 * the room was heard by everyone in the room. Someone switching accounts on
 * the shared device was in the room the whole time — logging in is not an
 * arrival. Starting their span at the switch would hand them an empty
 * transcript and leave Athena with no thread to pick up, which is the exact
 * failure this was built to fix.
 *
 * `left_at` is therefore what the spans are really for: a person who is
 * genuinely gone, and the stretch they must not be able to read when they come
 * back. Nothing closes a span today, so the filter is currently permissive for
 * everyone admitted — the machinery is here so that a client which models
 * stepping out has somewhere correct to say so.
 *
 * ## Why children can be participants but cannot join
 *
 * A child may be the session's *owner* — their conversation, which a parent
 * then joins on the same device. A child may never join someone else's, which
 * would be a kid reading their parent's conversation.
 *
 * That asymmetry is also why `audience.js` has to take the most restrictive
 * participant rather than the bound profile: once a parent joins a child's
 * session, an adult is talking in a session a child is still present for, and
 * the child-safe rules have to survive the switch.
 */
const pool = require("../helpers/db");

/**
 * A usable profile id, or null.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a plain finite check
 * quietly turns "no proven identity" into "profile 0" and carries it into an
 * access decision. Null, undefined, empty string and 0 are all refused here
 * instead, because none of them is a person.
 */
function profileNum(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Family roles that may join an existing conversation. Not 'child'. */
const JOINING_ROLES = ["owner", "parent", "guardian"];

/**
 * May this proven profile join this session?
 *
 * Fails closed everywhere: an unknown profile, an anonymous session, a family
 * the caller only used to belong to, or a child's account all return false.
 */
async function mayJoin(session, profileId) {
  const pid = profileNum(profileId);
  if (pid === null || !session) return false;

  const roles = JOINING_ROLES.map(() => "?").join(",");

  // The session already knows its family (child sessions carry it).
  if (session.family_id != null) {
    const [rows] = await pool.query(
      `SELECT 1 FROM family_members
			 WHERE family_id = ? AND profile_id = ?
			   AND deleted_at IS NULL AND status = 'active'
			   AND role IN (${roles})
			 LIMIT 1;`,
      [Number(session.family_id), pid, ...JOINING_ROLES],
    );
    if (rows.length) return true;
  }

  // Otherwise: do the caller and the session's owner share an active family?
  // The owner's role is deliberately unconstrained — they may be the child.
  if (session.profile_id != null) {
    const [rows] = await pool.query(
      `SELECT 1
			 FROM family_members me
			 JOIN family_members them ON them.family_id = me.family_id
			 WHERE me.profile_id = ? AND them.profile_id = ?
			   AND me.deleted_at IS NULL AND them.deleted_at IS NULL
			   AND me.status = 'active' AND them.status = 'active'
			   AND me.role IN (${roles})
			 LIMIT 1;`,
      [pid, Number(session.profile_id), ...JOINING_ROLES],
    );
    if (rows.length) return true;
  }

  return false;
}

/** Is this profile present in the session right now (an open span)? */
async function isParticipant(sessionId, profileId) {
  const pid = profileNum(profileId);
  if (pid === null || sessionId == null) return false;
  const [rows] = await pool.query(
    `SELECT 1 FROM session_participant
		 WHERE session_id = ? AND profile_id = ? AND left_at IS NULL
		 LIMIT 1;`,
    [sessionId, pid],
  );
  return rows.length > 0;
}

/**
 * Open a presence span, unless one is already open.
 *
 * Idempotent because the client calls it on every session resume, not only on
 * an account switch — the caller should not have to know which one this is.
 *
 * Two simultaneous joins can both see "no open span" and insert; the result is
 * two open spans for one person, which every read here tolerates (they all ask
 * whether ANY span covers a moment). A unique key would have been the stricter
 * fix and would also have forbidden the leave-and-return case this exists for.
 */
async function joinSession(
  sessionId,
  profileId,
  { via = "joined", joinedAt = null } = {},
) {
  const pid = profileNum(profileId);
  if (pid === null || sessionId == null) return { joined: false };
  if (await isParticipant(sessionId, pid))
    return { joined: false, present: true };
  const kind = via === "owner" ? "owner" : "joined";
  if (joinedAt) {
    await pool.query(
      `INSERT INTO session_participant (session_id, profile_id, via, joined_at)
			 VALUES (?, ?, ?, ?);`,
      [sessionId, pid, kind, joinedAt],
    );
  } else {
    await pool.query(
      `INSERT INTO session_participant (session_id, profile_id, via)
			 VALUES (?, ?, ?);`,
      [sessionId, pid, kind],
    );
  }
  return { joined: true, present: true };
}

/**
 * Close this profile's open span(s).
 *
 * Closing rather than deleting is the point: the transcript filter reads the
 * range, so a deleted span would silently re-expose the stretch they were away
 * for the next time they came back.
 */
async function leaveSession(sessionId, profileId) {
  const pid = profileNum(profileId);
  if (pid === null || sessionId == null) return { left: false };
  const [result] = await pool.query(
    `UPDATE session_participant SET left_at = NOW()
		 WHERE session_id = ? AND profile_id = ? AND left_at IS NULL;`,
    [sessionId, pid],
  );
  return { left: (result?.affectedRows ?? 0) > 0 };
}

/**
 * Everyone currently present, with a name to call them by.
 *
 * The name is what Athena says out loud, so it prefers what the family chose
 * to call this person over whatever Google put on the account.
 */
async function presentParticipants(sessionId) {
  if (sessionId == null) return [];
  const [rows] = await pool.query(
    `SELECT sp.profile_id,
		        MAX(sp.via)        AS via,
		        MIN(sp.joined_at)  AS joined_at,
		        COALESCE(MIN(fm.display_name), MIN(cp.display_name), MIN(p.full_name)) AS name
		 FROM session_participant sp
		 LEFT JOIN profile p ON p.id = sp.profile_id
		 LEFT JOIN child_profiles cp ON cp.profile_id = sp.profile_id AND cp.deleted_at IS NULL
		 LEFT JOIN family_members fm ON fm.profile_id = sp.profile_id AND fm.deleted_at IS NULL
		 WHERE sp.session_id = ? AND sp.left_at IS NULL
		 GROUP BY sp.profile_id
		 ORDER BY joined_at ASC;`,
    [sessionId],
  );
  return rows.map((r) => ({
    profileId: Number(r.profile_id),
    via: r.via,
    joinedAt: r.joined_at,
    // First name only. "Jacob:" in a transcript reads like a person;
    // "Jacob Bryson:" reads like a database row.
    name:
      typeof r.name === "string" && r.name.trim()
        ? r.name.trim().split(/\s+/)[0].slice(0, 40)
        : null,
  }));
}

/** Just the ids — for the audience check, which does not need names. */
async function presentProfileIds(sessionId) {
  return (await presentParticipants(sessionId)).map((p) => p.profileId);
}

module.exports = {
  JOINING_ROLES,
  mayJoin,
  isParticipant,
  joinSession,
  leaveSession,
  presentParticipants,
  presentProfileIds,
};
