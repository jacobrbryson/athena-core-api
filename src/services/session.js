const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");
const { buildUpdateClauses } = require("../helpers/query");
const participants = require("./sessionParticipant");

/**
 * Creates a new session record in the database.
 * @param {string} ipAddress The IP address of the user.
 * @returns {Promise<string>} The UUID of the new session.
 */
async function addSession(ipAddress, options = {}) {
  const sessionId = uuidv4();
  const mode =
    typeof options.mode === "string" && options.mode.trim()
      ? options.mode.trim()
      : "teach";
  const profileId = Number.isFinite(Number(options.profileId))
    ? Number(options.profileId)
    : null;
  const familyId = Number.isFinite(Number(options.familyId))
    ? Number(options.familyId)
    : null;

  const [result] = await pool.query(
    "INSERT INTO session (uuid, ip_address, mode, profile_id, family_id) VALUES (?, ?, ?, ?, ?)",
    [sessionId, ipAddress, mode, profileId, familyId],
  );

  // The person it was created for is present from the first moment. Every
  // bound session needs a span or the transcript filter, which is fail-closed,
  // would hide their own conversation from them.
  if (profileId != null && result?.insertId) {
    await participants
      .joinSession(result.insertId, profileId, { via: "owner" })
      .catch((e) => console.warn("[session] owner participant:", e.message));
  }

  return sessionId;
}

/**
 * This person's current conversation, starting one if they have none.
 *
 * For channels that arrive without a session of their own — a text message is
 * the first — where the alternative is a brand-new session per inbound
 * message. That would give Athena a second, thinner memory of the same person
 * and make "what did we decide?" depend on which device they happened to ask
 * from.
 *
 * Reuses a session only while it is recent. An SMS answered into a thread from
 * three weeks ago would be replying inside a conversation neither party
 * remembers having; a day is long enough that a morning and an evening text
 * are the same thread, and short enough that a stale one is not resurrected.
 */
async function getOrCreateForProfile(profileId, { ip = "sms", mode = null } = {}) {
  const id = Number(profileId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("A profile is required");

  const [rows] = await pool.query(
    `SELECT id, ip_address, uuid, created_at, age, is_busy, wisdom_points,
            mode, profile_id, family_id
     FROM session
     WHERE profile_id = ? AND created_at >= NOW() - INTERVAL 1 DAY
     ORDER BY created_at DESC LIMIT 1`,
    [id],
  );
  if (rows[0]) return rows[0];

  const [[profile]] = await pool.query(
    `SELECT cp.family_id FROM profile p
     LEFT JOIN child_profiles cp ON cp.profile_id = p.id
     WHERE p.id = ? LIMIT 1`,
    [id],
  );
  const uuid = await addSession(ip, {
    profileId: id,
    familyId: profile?.family_id || null,
    ...(mode ? { mode } : {}),
  });
  const [fresh] = await pool.query(
    `SELECT id, ip_address, uuid, created_at, age, is_busy, wisdom_points,
            mode, profile_id, family_id
     FROM session WHERE uuid = ? LIMIT 1`,
    [uuid],
  );
  return fresh[0];
}

/** Resolve a profile.id (and its family) from a profile uuid, or null. */
async function resolveProfileBinding(profileUuid) {
  if (typeof profileUuid !== "string" || !profileUuid.trim()) return {};
  const [rows] = await pool.query(
    `SELECT p.id AS profile_id, cp.family_id
     FROM profile p
     LEFT JOIN child_profiles cp ON cp.profile_id = p.id
     WHERE p.uuid = ? LIMIT 1;`,
    [profileUuid.trim()],
  );
  if (!rows.length) return {};
  return { profileId: rows[0].profile_id, familyId: rows[0].family_id || null };
}

/** The same binding, for a profile id the caller has already proven. */
async function resolveProfileIdBinding(profileId) {
  const id = Number(profileId);
  if (!Number.isFinite(id) || id <= 0) return {};
  const [rows] = await pool.query(
    `SELECT p.id AS profile_id, cp.family_id
     FROM profile p
     LEFT JOIN child_profiles cp ON cp.profile_id = p.id
     WHERE p.id = ? LIMIT 1;`,
    [id],
  );
  if (!rows.length) return {};
  return { profileId: rows[0].profile_id, familyId: rows[0].family_id || null };
}

/**
 * Retrieves a session record by UUID alone. Authorization is the caller's job —
 * use `getAuthorizedSession`, which is what every controller should call.
 *
 * `ip` is still accepted and, when given, still filtered on; that path is only
 * used for anonymous sessions which have no identity to check instead.
 *
 * @param {string} uuid The session UUID.
 * @param {string|null} ip Optional IP to require a match on.
 * @returns {Promise<object | undefined>} The session record or undefined.
 */
async function getSessionByUuidAndIp(uuid, ip = null) {
  const [rows] = await pool.query(
    `SELECT 
    s.id,
    s.ip_address,
		s.uuid,
		s.created_at,
		s.age,
		s.is_busy,
		s.wisdom_points,
		s.mode,
		s.profile_id,
		s.family_id
FROM session s
WHERE s.uuid = ?${ip ? " AND s.ip_address = ?" : ""} LIMIT 1;`,
    ip ? [uuid, ip] : [uuid],
  );

  return rows[0];
}

/**
 * Fetch a session the caller is actually entitled to.
 *
 * Sessions used to be resumable by (uuid + IP), which broke every time a child
 * moved between wifi and cell data — they silently got a brand-new session and
 * lost their conversation and any activity in progress. Identity is the correct
 * key, so:
 *
 *   - A session bound to a profile requires the caller to have PROVEN that same
 *     profile via a signed token. This is strictly stronger than the old IP
 *     check (a signature can't be spoofed by forging a header) and it survives
 *     changing networks.
 *   - A genuinely anonymous session (profile_id IS NULL) has no identity to
 *     compare, so it keeps the IP check as its only protection.
 *
 * @param {string} uuid session uuid
 * @param {object} opts { ip, callerProfileId }
 * @returns {Promise<object|null>} the session, or null if absent/unauthorized.
 */
async function getAuthorizedSession(
  uuid,
  { ip = null, callerProfileId = null } = {},
) {
  if (!uuid) return null;
  const session = await getSessionByUuidAndIp(uuid, null);
  if (!session) return null;

  if (session.profile_id != null) {
    if (Number(callerProfileId) === Number(session.profile_id)) return session;
    // A second guardian who has already been admitted to this conversation
    // (see sessionParticipant.mayJoin — shared active family, adult role,
    // proven by signed token). This read path only RECOGNIZES membership; it
    // never grants it, so nothing here can widen its own access.
    if (
      callerProfileId != null &&
      (await participants
        .isParticipant(session.id, callerProfileId)
        .catch(() => false))
    ) {
      return session;
    }
    return null;
  }
  // Anonymous session — nothing to authenticate against but the network.
  if (!ip || session.ip_address !== ip) return null;
  return session;
}

/**
 * Admit a proven profile into a conversation that is not theirs.
 *
 * This is the ONE place membership is granted, so it is the one place to read
 * when asking how somebody came to be in a session. `getAuthorizedSession`
 * only ever recognizes an existing membership; it cannot create one.
 *
 * The caller must already have proven this profile with a signed token — the
 * controller passes `resolveCallerProfileId(req)`, never anything from the
 * body or query. `mayJoin` then requires a shared active family and an adult
 * role, so a session uuid on its own still admits nobody.
 *
 * Returns the session on success, null when this caller may not join — which
 * the controller treats exactly as it always treated an unauthorized session:
 * by starting a new one.
 */
async function admitToSession(uuid, callerProfileId) {
  if (!uuid || callerProfileId == null) return null;
  const session = await getSessionByUuidAndIp(uuid, null);
  if (!session) return null;
  if (!(await participants.mayJoin(session, callerProfileId))) return null;

  // From the START of the conversation, not from this moment. They were in
  // the room while it happened; authenticating is not arriving. Opening the
  // span at the switch would give them a blank transcript and leave Athena
  // with nothing to continue — the exact failure this exists to fix.
  await participants.joinSession(session.id, callerProfileId, {
    via: "joined",
    joinedAt: session.created_at || null,
  });

  // Reading somebody else's conversation is an access event, so it leaves a
  // record like every other one. Failing to write it must not fail the join —
  // the person is already in the room — but it is logged loudly.
  try {
    await pool.query(
      "INSERT INTO athena_access_audit (subject, action, actor) VALUES (?, ?, ?)",
      [session.uuid, "session_joined", String(callerProfileId)],
    );
  } catch (err) {
    console.error("[session] join audit failed:", err.message);
  }

  return session;
}

/**
 * Safely updates specific fields in a session record.
 * Only 'age' (number) and 'is_busy' (boolean) are allowed for update.
 * @param {string} uuid The session UUID to update.
 * @param {object} updates Object containing keys to update (e.g., {age: 30, is_busy: true}).
 * @returns {Promise<object>} The result object from the database query.
 */
async function updateSession(sessionId, updates) {
  const allowedUpdates = {
    age: "number",
    is_busy: "boolean",
    wisdom_points: "number",
    mode: "string",
  };

  try {
    const { setClauses, values } = buildUpdateClauses(updates, allowedUpdates);
    const queryValues = [...values, sessionId];
    const sql = `UPDATE session SET ${setClauses} WHERE id = ?`;

    const [result] = await pool.query(sql, queryValues);
    return result;
  } catch (error) {
    console.error(
      `[Session Service] Failed to update session ${sessionId}:`,
      error.message,
    );
    return { message: error.message };
  }
}

/**
 * Bind a previously-unbound session to a profile (and its family). Used to
 * upgrade an anonymous/IP-bound session once we know the acting profile (e.g.
 * a logged-in parent whose first session was created before their profile was
 * resolved). The `profile_id IS NULL` guard means an already-bound session is
 * never silently reassigned.
 */
async function bindSessionProfile(sessionId, profileId, familyId = null, { joinedAt = null } = {}) {
  if (!Number.isFinite(Number(profileId))) return { affectedRows: 0 };
  const [result] = await pool.query(
    `UPDATE session SET profile_id = ?, family_id = ?
		 WHERE id = ? AND profile_id IS NULL`,
    [
      Number(profileId),
      Number.isFinite(Number(familyId)) ? Number(familyId) : null,
      sessionId,
    ],
  );
  if ((result?.affectedRows ?? 0) > 0) {
    await participants
      .joinSession(sessionId, profileId, { via: "owner", joinedAt })
      .catch((e) => console.warn("[session] bind participant:", e.message));
  }
  return result;
}

const SESSION_COLUMNS = `s.id, s.ip_address, s.uuid, s.created_at, s.age, s.is_busy,
  s.wisdom_points, s.mode, s.profile_id, s.family_id`;

/**
 * This person's conversation in a mode — the one they spoke in most recently.
 *
 * The clients used to key a conversation by a uuid saved in that browser, so a
 * second device (or a cleared cache) started a blank one and Athena lost the
 * thread. One person has one conversation per mode; whichever device they pick
 * up continues it.
 */
async function latestForProfile(profileId, mode) {
  const id = Number(profileId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const [rows] = await pool.query(
    `SELECT ${SESSION_COLUMNS},
            COALESCE((SELECT MAX(m.created_at) FROM message m WHERE m.session_id = s.id),
                     s.created_at) AS last_active_at
     FROM session s
     WHERE s.profile_id = ? AND s.mode = ?
     ORDER BY last_active_at DESC, s.id DESC LIMIT 1;`,
    [id, mode],
  );
  if (!rows[0]) return null;
  const { last_active_at, ...session } = rows[0];
  return session;
}

/**
 * Fold one of a person's conversations into another so nothing said on the
 * other device disappears from view.
 *
 * Only ever between two sessions that person owns alone. Presence is the
 * disclosure boundary (message.js), and a span on the target is a time range:
 * moving messages into a session somebody else has joined would show them a
 * conversation they were never in. So a session anyone else has been part of
 * is left exactly where it is, and false is returned.
 */
async function mergeSessionInto(target, source, profileId) {
  const pid = Number(profileId);
  if (!target || !source || target.id === source.id) return false;
  if (Number(target.profile_id) !== pid || Number(source.profile_id) !== pid) return false;

  const [[others]] = await pool.query(
    `SELECT COUNT(*) AS n FROM session_participant
     WHERE session_id IN (?, ?) AND profile_id <> ?;`,
    [target.id, source.id, pid],
  );
  if (Number(others?.n) > 0) return false;

  const [cursors] = await pool.query(
    `SELECT session_id, last_created_at FROM memory_extraction_cursor
     WHERE session_id IN (?, ?);`,
    [target.id, source.id],
  );
  const cursorOf = (sid) =>
    cursors.find((c) => Number(c.session_id) === Number(sid))?.last_created_at || null;
  const [[pending]] = await pool.query(
    `SELECT MIN(m.created_at) AS first_at FROM message m
     WHERE m.session_id = ?${cursorOf(source.id) ? " AND m.created_at > ?" : ""};`,
    cursorOf(source.id) ? [source.id, cursorOf(source.id)] : [source.id],
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE message SET session_id = ? WHERE session_id = ?;", [
      target.id,
      source.id,
    ]);
    // Reminder and code-fix updates thread onto their origin message by
    // (action, session), so the action has to move with its message.
    await conn.query(
      "UPDATE athena_action SET session_id = ? WHERE session_id = ? AND profile_id = ?;",
      [target.id, source.id, pid],
    );
    // They were present for everything they said on the other device; the
    // owner span must cover it or the fail-closed filter hides it.
    await conn.query(
      `UPDATE session_participant SET joined_at = LEAST(joined_at, ?)
       WHERE session_id = ? AND profile_id = ?;`,
      [source.created_at || new Date(0), target.id, pid],
    );
    // Anything the other device said that memory extraction has not read yet
    // must still be read — pull the target's cursor back to before it.
    if (pending?.first_at) {
      const before = new Date(new Date(pending.first_at).getTime() - 1000);
      const current = cursorOf(target.id);
      if (current && new Date(current) > before) {
        await conn.query(
          "UPDATE memory_extraction_cursor SET last_created_at = ? WHERE session_id = ?;",
          [before, target.id],
        );
      }
    }
    await conn.query("DELETE FROM memory_extraction_cursor WHERE session_id = ?;", [
      source.id,
    ]);
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  return true;
}

/**
 * The conversation a signed-in person should be looking at.
 *
 * `current` is the session this device remembered, if it is theirs. When
 * another of their sessions in the same mode is more recent, this device's is
 * merged into it and that one is returned; when the merge is not safe (the
 * device's session is shared with someone) the device keeps its own.
 */
async function resumeForProfile(profileId, mode, current = null) {
  const latest = await latestForProfile(profileId, mode);
  if (!latest) return current;
  if (!current) return latest;
  if (Number(current.profile_id) !== Number(profileId)) return current;
  if (current.mode !== mode || latest.id === current.id) return current;
  const merged = await mergeSessionInto(latest, current, profileId).catch((err) => {
    console.warn("[session] merge failed:", err.message);
    return false;
  });
  return merged ? latest : current;
}

module.exports = {
  addSession,
  latestForProfile,
  mergeSessionInto,
  resumeForProfile,
  getOrCreateForProfile,
  getSessionByUuidAndIp,
  getAuthorizedSession,
  admitToSession,
  updateSession,
  resolveProfileBinding,
  resolveProfileIdBinding,
  bindSessionProfile,
};
