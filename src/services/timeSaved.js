const pool = require('../helpers/db');
const { ACTIONS } = require('./actions/registry');

// Time Athena has saved one person, counted only from actions she actually
// carried out after an approval (athena_action rows that reached 'done').
// Proposals, declines, failures, answers and briefs count for nothing yet: the
// figure has to survive a skeptic, so it undercounts rather than guesses.
//
// Minutes are what doing the same thing by hand takes, net of reading and
// approving the card, and deliberately on the low side. An action that saves
// nothing measurable is 0 and is listed as "not counted", never silently
// dropped — it becomes worth something only when someone decides it here.
//
// Rates are PER ITEM: one approval that archives 30 emails counts 30 items,
// read from the approved params (email_triage_uuids / items). An item skipped
// at execute time because it had already left the inbox still counts, which
// is rare enough to live with, and noted here so nobody is surprised.
const MINUTES = {
  create_calendar_event: 2, // open Calendar, type the title, pick the time
  file_travel_or_school_email: 2.5, // the event above, plus labelling the email
  file_receipt_email: 0.5, // label and archive one email
  delete_email: 0.25, // open it and trash it
  add_email_events: 2.5, // per event: the same as file_travel_or_school_email
  unsubscribe_senders: 1, // per sender: find the link, click through, confirm
  draft_reply: 2, // per draft saved: reading it and writing a first reply
  archive_emails: 0.1, // six seconds each: select and archive in the Gmail app
  remember_fact: 0.5, // writing the note down yourself
  dismiss_email: 0, // hides a row in Athena's own list; Gmail is untouched
  look_through_camera: 0, // no fair hand-done equivalent to price yet
  remind_at_place: 0, // nothing you'd do by hand that this replaces, so nothing to price
};

const labels = new Map(ACTIONS.map((a) => [a.id, a.label]));
const minutesFor = (actionId) => MINUTES[actionId] ?? 0;
const round = (n) => Math.round(n * 10) / 10;

/** UTC calendar month start, `offset` months from the one `now` is in. */
function monthStart(now, offset = 0) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

async function getTimeSaved(profileId, now = new Date()) {
  const thisMonth = monthStart(now), lastMonth = monthStart(now, -1);
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6));
  // One grouped read; everything else is arithmetic here, where it can be tested.
  const [rows] = await pool.query(
    `SELECT action_id, DATE_FORMAT(executed_at, '%Y-%m-%d') AS day,
            SUM(COALESCE(JSON_LENGTH(params, '$.email_triage_uuids'), JSON_LENGTH(params, '$.items'), 1)) AS n
       FROM athena_action
      WHERE profile_id = ? AND status = 'done' AND executed_at IS NOT NULL
      GROUP BY action_id, day`,
    [profileId],
  );
  const monthKey = (d) => d.toISOString().slice(0, 7);
  const byAction = new Map();
  const daily = new Map();
  const totals = { thisMonth: 0, lastMonth: 0, allTime: 0, actionsThisMonth: 0, actionsAllTime: 0 };
  let since = null;
  for (const r of rows) {
    const n = Number(r.n) || 0;
    const minutes = n * minutesFor(r.action_id);
    const month = String(r.day).slice(0, 7);
    if (!since || r.day < since) since = r.day;
    totals.allTime += minutes;
    totals.actionsAllTime += n;
    if (month === monthKey(lastMonth)) totals.lastMonth += minutes;
    if (month === monthKey(thisMonth)) {
      totals.thisMonth += minutes;
      totals.actionsThisMonth += n;
      const a = byAction.get(r.action_id) || { actionId: r.action_id, label: labels.get(r.action_id) || r.action_id, count: 0, minutesEach: minutesFor(r.action_id), minutes: 0 };
      a.count += n;
      a.minutes += minutes;
      byAction.set(r.action_id, a);
    }
    if (r.day >= weekStart.toISOString().slice(0, 10)) daily.set(r.day, (daily.get(r.day) || 0) + minutes);
  }
  return {
    checkedAt: now.toISOString(),
    month: monthKey(thisMonth),
    since,
    minutesThisMonth: round(totals.thisMonth),
    minutesLastMonth: round(totals.lastMonth),
    minutesAllTime: round(totals.allTime),
    actionsThisMonth: totals.actionsThisMonth,
    actionsAllTime: totals.actionsAllTime,
    byAction: [...byAction.values()].map((a) => ({ ...a, minutes: round(a.minutes) })).sort((a, b) => b.minutes - a.minutes || b.count - a.count),
    daily: [...daily].map(([date, minutes]) => ({ date, minutes: round(minutes) })).sort((a, b) => a.date.localeCompare(b.date)),
    rates: ACTIONS.map((a) => ({ actionId: a.id, label: a.label, minutesEach: minutesFor(a.id) })),
  };
}

module.exports = { getTimeSaved, MINUTES, minutesFor };
