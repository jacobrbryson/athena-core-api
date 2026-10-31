const pool = require('../helpers/db');
const { ACTIONS, DIRECT_ACTIONS } = require('./actions/registry');
const codeAgents = require('./codeAgents');

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
  plan_work_item: 0,
  // Sending a review is the person's own judgment, and undoing an archive saves nothing.
  submit_workspace_review: 0,
  unarchive_emails: 0,
  implement_work_item: 0,
  // Project execution records are coordination, not independently measured savings.
  update_project_step: 0,
  schedule_project_work: 0,
  record_project_session: 0,
  put_project_session_on_calendar: 0,
  close_out_project: 0,
  create_calendar_event: 2, // open Calendar, type the title, pick the time
  file_travel_or_school_email: 2.5, // the event above, plus labelling the email
  file_receipt_email: 0.5, // label and archive one email
  delete_email: 0.25, // open it and trash it
  add_email_events: 2.5, // per event: the same as file_travel_or_school_email
  unsubscribe_senders: 1, // per sender: find the link, click through, confirm
  draft_reply: 2, // per draft saved: reading it and writing a first reply
  archive_emails: 0.1, // six seconds each: select and archive in the Gmail app
  remember_fact: 0.5, // writing the note down yourself
  log_health_update: 0.5, // writing the reading down yourself
  dismiss_email: 0, // hides a row in Athena's own list; Gmail is untouched
  look_through_camera: 0, // no fair hand-done equivalent to price yet
  remind_at_place: 0, // nothing you'd do by hand that this replaces, so nothing to price
  remind_at_time: 0, // the same reminder you'd set on your phone, so nothing to price
  // Per approval: finding the due date, two calendar entries, and updating the record by hand.
  record_vehicle_bill: 3,
  record_property_tax_bill: 3,
  record_vehicle_notice: 1, // typing the letter's key points into a note
  set_guardian_reports: 0, // changing a setting; nothing done by hand that this replaces
  // Per approval, not per item: a batch stores grocery_items, which the count
  // below doesn't read, so ten items count once — an undercount, on purpose.
  update_grocery_list: 0.5, // open Keep, find the list, type it in
  set_thermostat: 0.5, // open the Nest app, pick the thermostat, change it
  add_project: 1, // create the project and type its title, area and first steps
  update_project: 0.5, // open the project and tick, note or re-date it
  // Writing the bug up and finding the right file yourself. The debugging the
  // agents do is worth more, but how much varies too much to claim it.
  investigate_code: 5,
  // Making a small fix yourself, priced at the small ones the agents mostly
  // get (a padding tweak is a few minutes by hand): bigger fixes undercount.
  // Only a fix whose pull request merged counts (see MERGE_GATED).
  fix_code: 3,
};

// Actions whose 'done' means only "handed to someone else": they count once
// GitHub says the pull request merged, and nothing while it is open, closed,
// unknown, or GitHub can't be reached.
const MERGE_GATED = new Set(['fix_code']);

// Direct actions (a tick on the Family page) save nothing over ticking it in
// the app itself, so they have no rate and count 0; they still get their label.
const labels = new Map([...ACTIONS, ...DIRECT_ACTIONS].map((a) => [a.id, a.label]));
const minutesFor = (actionId) => MINUTES[actionId] ?? 0;
const round = (n) => Math.round(n * 10) / 10;

/** UTC calendar month start, `offset` months from the one `now` is in. */
function monthStart(now, offset = 0) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

/** Merge-gated actions as grouped rows, one per merged pull request. */
async function mergedRows(profileId) {
  const [done] = await pool.query(
    `SELECT action_id, DATE_FORMAT(executed_at, '%Y-%m-%d') AS day, result_ref
       FROM athena_action
      WHERE profile_id = ? AND status = 'done' AND executed_at IS NOT NULL
        AND action_id IN (?)`,
    [profileId, [...MERGE_GATED]],
  );
  const states = await Promise.all(
    done.map((r) => codeAgents.fixStatus(r.result_ref).then((s) => s.state, () => 'unknown')),
  );
  return done.filter((_, i) => states[i] === 'merged').map((r) => ({ action_id: r.action_id, day: r.day, n: 1 }));
}

async function getTimeSaved(profileId, now = new Date()) {
  const thisMonth = monthStart(now), lastMonth = monthStart(now, -1);
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6));
  // One grouped read plus the merge check; everything else is arithmetic here,
  // where it can be tested.
  const [rows] = await pool.query(
    `SELECT action_id, DATE_FORMAT(executed_at, '%Y-%m-%d') AS day,
            SUM(COALESCE(JSON_LENGTH(params, '$.email_triage_uuids'), JSON_LENGTH(params, '$.items'), 1)) AS n
       FROM athena_action
      WHERE profile_id = ? AND status = 'done' AND executed_at IS NOT NULL
        AND action_id NOT IN (?)
      GROUP BY action_id, day`,
    [profileId, [...MERGE_GATED]],
  );
  rows.push(...(await mergedRows(profileId)));
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
