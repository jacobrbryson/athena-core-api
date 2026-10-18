// Read-only, deterministic dashboard data. Reuses the existing scoped readers;
// never calls a model, approves an action, or creates a provider connection.
const credentials = require('./credentials');
const consent = require('./consent');
const calendar = require('./connectors/googleCalendar');
const whoop = require('./connectors/whoop');
const vesync = require('./connectors/vesync');
const integration = require('./integration');
const chores = require('./familyChores');
const clock = require('./clock');
const work = require('./connectors/work');
const emailTriage = require('./emailTriage');
const emailSync = require('./emailSync');
const familyHealth = require('./familyHealth');
const keep = require('./connectors/googleKeep');

const { technicalDetail } = require('./connectors/context');

const section = (status, data = null, detail = null) => ({ status, data, detail, checkedAt: new Date().toISOString() });

// Last computed dashboard per profile. Read only by the prioritiser, which runs
// immediately after the client's own /dashboard call and must not re-hit every
// provider to see the same snapshot the person is already looking at. Short
// TTL on purpose: a stale snapshot would rank a card against data the person
// can no longer see.
const CACHE_TTL_MS = 120_000;
const snapshots = new Map(); // profileId => { at, data }

/** The snapshot behind the person's current view, or null when it has aged out. */
function cachedDashboard(profileId) {
  const entry = snapshots.get(profileId);
  if (!entry || Date.now() - entry.at > CACHE_TTL_MS) {
    snapshots.delete(profileId);
    return null;
  }
  return entry.data;
}
/**
 * A card that could not be read, with the reason it could not be read.
 *
 * `detail` is the provider's own account of the failure, run through the same
 * redaction the grounding layer uses, and it only exists because every route
 * into this module is behind requireAdultActor. Without it a blank Work card
 * and a Gmail API that was never enabled on the project are the same pixel,
 * and the only move left to the person is to reconnect a link that is fine.
 */
function failure(err) {
  // Never expose provider error bodies, internal addresses or credentials.
  const detail = technicalDetail(err);
  if (err?.code === 'not_connected' && err.reason !== 'unreadable') return section('needs_reauth', null, detail);
  return section('error', null, detail);
}
async function read(fn) {
  try { return section('ready', await fn()); } catch (err) { return failure(err); }
}

async function getDashboard(profileId, user) {
  let statuses;
  try {
    statuses = new Map();
    for (const link of await credentials.list(profileId)) {
      if (statuses.get(link.provider) !== 'active') statuses.set(link.provider, link.status);
    }
  } catch { statuses = null; }
  const healthConsent = await consent.hasConsentForProfile(profileId, 'health_data').catch(() => false);
  async function provider(id, fn, health = false) {
    if (!statuses) return section('error');
    if (!statuses.has(id)) return section('not_connected');
    if (statuses.get(id) !== 'active') return section('needs_reauth');
    if (health && !healthConsent) return section('consent_required');
    return read(fn);
  }
  const [calendarData, recovery, sleep, strain, body, familyChores, jira, slack, emailTriageData, familyHealthData, groceries] = await Promise.all([
    provider('google_calendar', async () => {
      const result = await calendar.collectEvents(profileId, { days: 7, maxResults: 25 });
      const timeZone = calendar.displayTimeZone(result.calendars);
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const date = Object.fromEntries(parts.map(p => [p.type, p.value]));
      const today = `${date.year}-${date.month}-${date.day}`;
      // Keep ongoing events, discard events that already ended. All-day end
      // dates are exclusive calendar dates, not UTC timestamps.
      const notOver = e => e.allDay
        ? (e.end || e.start) > today || (!e.end && e.start === today)
        : new Date(e.end || e.start).getTime() > Date.now();
      const events = result.events.filter(notOver);
      // Where the person is working ("Home 7-4"), kept apart from the events so
      // the Work banner can read it and no card mistakes it for a meeting.
      const workingLocations = (result.workingLocations || []).filter(notOver);
      return { events, workingLocations, timeZone, days: 7 };
    }),
    // Recovery and cycles reach back a fortnight, not a week: the resting
    // heart rate and HRV they carry only mean anything against a baseline, and
    // a baseline built from the three or four days either side of today moves
    // with whatever it is supposed to be measuring. The panels still draw the
    // last seven; the extra days exist to be compared against.
    provider('whoop', () => whoop.listRecovery(profileId, { days: 14, limit: 14 }), true),
    provider('whoop', () => whoop.listSleep(profileId, { days: 7, limit: 7 }), true),
    provider('whoop', () => whoop.listCycles(profileId, { days: 14, limit: 14 }), true),
    // Ninety days of weigh-ins: a week of weight is mostly water, and the
    // trend the Health page draws needs a month or more to mean anything.
    provider('vesync', () => vesync.bodySummary(profileId), true),
    (async () => {
      try {
        const status = await integration.getStatus(user, integration.PROVIDER_FAMILY_CHORES);
        if (!status.connected) return section('not_connected');
        const creds = await integration.getUsableCredentials(profileId);
        if (!creds?.playerId) return section('error');
        // "Today" means what Family Chores' own Today list shows: every open
        // chore due today or earlier, overdue ones included. /chores/today only
        // returns chores due exactly today (in UTC), so a week-old chore that
        // is still on the person's list vanished here. Chores finished today
        // ride along so the done/total count means something.
        const opts = { token: creds.token, baseUrl: creds.baseUrl };
        const today = clock.describeNow(new Date()).iso;
        return read(async () => {
          const [open, done, canComplete] = await Promise.all([
            chores.getChores(creds.playerId, { range: 'all', status: 'open', includeRecurring: false }, opts),
            chores.getChores(creds.playerId, { range: 'today', status: 'completed', includeRecurring: false }, opts),
            // Whether the page may offer the checkbox: the token needs
            // write:chores, which tokens minted before 2026-10-14 lack.
            integration.canWriteChores(profileId, creds).catch(() => false),
          ]);
          const due = open.filter(c => !c.dueDate || c.dueDate <= today)
            .sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
          return {
            name: creds.displayName,
            // The Family Chores site itself, for the page's "View all" link.
            appUrl: /^https:\/\//.test(creds.baseUrl || '') ? creds.baseUrl : null,
            // Ticking a chore runs the complete_chore action (actions/registry.js
            // DIRECT_ACTIONS); a read-only token gets the reconnect link instead,
            // which is where Family Chores re-mints Athena's token.
            canComplete,
            reconnectUrl: /^https:\/\//.test(creds.baseUrl || '') ? `${creds.baseUrl.replace(/\/+$/, '')}/profile?tab=integrations` : null,
            chores: [...due, ...done].slice(0, 25).map(c => ({ id: c.id ? String(c.id) : null, title: c.title || 'Untitled chore', status: c.status || null, completed: !!c.completed, dueDate: c.dueDate || null })),
          };
        });
      } catch { return section('error'); }
    })(),
    provider('jira', () => work.jira(profileId)),
    provider('slack', () => work.slack(profileId)),
    // Gated on the 'gmail' credential like every other provider() call here,
    // but the data behind it is now the triage summary (see services/emailTriage.js),
    // not the old "5 unread subjects" work.gmail() reader.
    // A quick sync first (history only, no model) so the card reflects what
    // happened in Gmail since the last look. A failed sync still shows the
    // card from what is stored — it is logged, not surfaced as an outage.
    provider('gmail', async () => {
      await emailSync.syncIfStale(profileId).catch(err => console.warn('[dashboard] mail sync failed:', err?.message || err));
      return emailTriage.summary(profileId);
    }),
    // Not gated on a linked provider — this is Athena's own family data, same
    // as familyChores' memories fallback, so it is always 'ready' unless the
    // read itself fails.
    read(async () => ({ active: await familyHealth.activeFor(profileId) })),
    // The shared Keep grocery list (connectors/googleKeep). The page shows what
    // the family is out of; the regulars are only counted, since a years-old
    // list has hundreds and they are background for meal ideas, not a to-do.
    provider('google_keep', async () => {
      const { lists } = await keep.groceries(profileId);
      return {
        lists: lists.map(l => ({ title: l.title, toBuy: l.toBuy.slice(0, 50), usualCount: (l.usuallyBuys || []).length })),
        appUrl: 'https://keep.google.com/',
      };
    }),
  ]);
  const result = { calendar: calendarData, recovery, sleep, strain, body, familyChores, jira, slack, emailTriage: emailTriageData, familyHealth: familyHealthData, groceries };
  for (const [id, entry] of snapshots) if (Date.now() - entry.at >= CACHE_TTL_MS) snapshots.delete(id);
  if (snapshots.size >= 128) snapshots.delete(snapshots.keys().next().value);
  snapshots.set(profileId, { at: Date.now(), data: result });
  return result;
}
module.exports = { getDashboard, cachedDashboard };
