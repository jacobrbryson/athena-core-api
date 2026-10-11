/** Durable chat context. Reads action records; never confirms or executes one. */
const pool = require('../helpers/db');
const { createHash } = require('node:crypto');

async function hydrate(messages, profileId) {
  if (!profileId) return messages;
  return Promise.all(messages.map(async (message) => {
    if (!message.action_uuid) return message;
    const action = await require('./actions').get(profileId, message.action_uuid);
    if (!action) return message;
    if (action.status === 'pending' && new Date(action.expires_at).getTime() <= Date.now()) {
      action.status = 'expired';
    }
    return { ...message, action };
  }));
}

/** Materialize reminder occurrences even after the temporary notification expires.
 * INSERT IGNORE + occurrence key makes retries/reloads idempotent. The original
 * nudge timestamp describes when the in-app reminder was posted, not seen.
 * No push, reaction, consent or initiative state is changed here.
 */
async function syncReminderUpdates(sessionId, profileId) {
  if (!profileId) return;
  await pool.query(
    `INSERT IGNORE INTO message
      (session_id, uuid, is_human, text, mode, created_at, reply_to_uuid, private_profile_id, event_key)
     SELECT root.session_id, n.uuid, 0, n.text, root.mode, n.created_at,
       COALESCE(root.reply_to_uuid, root.uuid), n.profile_id, CONCAT('reminder:', n.uuid)
     FROM athena_nudge n
     JOIN (
       SELECT uuid, profile_id, action_uuid FROM athena_time_reminder
       UNION ALL SELECT uuid, profile_id, action_uuid FROM athena_place_reminder
     ) reminder ON reminder.uuid = JSON_UNQUOTE(JSON_EXTRACT(n.facts, '$.reminderUuid'))
       AND reminder.profile_id = n.profile_id
     JOIN athena_action a ON a.uuid = reminder.action_uuid AND a.profile_id = n.profile_id
     JOIN message root ON root.action_uuid = a.uuid AND root.session_id = a.session_id
     WHERE root.session_id = ? AND n.profile_id = ?
       AND n.trigger_id IN ('time_reminder', 'place_reminder')`,
    [sessionId, profileId],
  );
}

/** Shared sink for future background prompt outcomes. Only the action owner's
 * existing origin message can receive an update; the event key dedupes retries.
 */
async function appendActionUpdate(profileId, actionUuid, eventKey, text, at = new Date()) {
  const hex = createHash('sha256').update(`${actionUuid}:${eventKey}`).digest('hex').slice(0, 32);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  await pool.query(
    `INSERT IGNORE INTO message
      (session_id, uuid, is_human, text, mode, created_at, reply_to_uuid, private_profile_id, event_key)
     SELECT root.session_id, ?, 0, ?, root.mode, ?, COALESCE(root.reply_to_uuid, root.uuid), a.profile_id, ?
     FROM athena_action a JOIN message root ON root.action_uuid = a.uuid AND root.session_id = a.session_id
     WHERE a.uuid = ? AND a.profile_id = ? LIMIT 1`,
    [uuid, text.slice(0, 12000), at, `action:${actionUuid}:${eventKey}`.slice(0, 191), actionUuid, profileId],
  );
}

async function syncCodeUpdates(sessionId, profileId) {
  if (!profileId) return;
  const [rows] = await pool.query(
    `SELECT a.uuid, a.action_id, a.result_ref FROM athena_action a
     WHERE a.session_id = ? AND a.profile_id = ? AND a.status = 'done'
       AND a.action_id IN ('fix_code', 'investigate_code')
       AND EXISTS (SELECT 1 FROM message root WHERE root.action_uuid = a.uuid)
     ORDER BY a.created_at DESC LIMIT 8`, [sessionId, profileId],
  );
  if (!rows.length) return;
  const code = require('./codeAgents');
  if (!(await code.mayUse(profileId))) return;
  for (const row of rows) {
    try {
      if (row.action_id === 'investigate_code') {
        for (const finding of await code.findings(row.result_ref)) {
          await appendActionUpdate(profileId, row.uuid, `finding:${finding.agent}`,
            `${finding.agent === 'claude' ? 'Claude Code' : 'Codex'} reported these findings (not independently verified):\n\n${finding.text}`, new Date(finding.at));
        }
      } else {
        const result = await code.fixStatus(row.result_ref);
        const wording = { open: 'A pull request is open.', merged: 'The pull request merged. Deployment has not been verified here.',
          closed: 'The pull request closed without merging.', failed: 'The coding agent could not finish the change.',
          no_change: 'The coding agent finished without making a change.' }[result.state];
        if (wording) await appendActionUpdate(profileId, row.uuid, `fix:${result.state}`, `${wording}${result.url ? `\n${result.url}` : ''}`);
      }
    } catch (err) { console.warn('[chatThreads] code update unavailable:', err.message); }
  }
}

module.exports = { hydrate, syncReminderUpdates, appendActionUpdate, syncCodeUpdates };
