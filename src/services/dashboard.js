// Read-only, deterministic dashboard data. Reuses the existing scoped readers;
// never calls a model, approves an action, or creates a provider connection.
const credentials = require('./credentials');
const consent = require('./consent');
const calendar = require('./connectors/googleCalendar');
const whoop = require('./connectors/whoop');
const strava = require('./connectors/strava');
const integration = require('./integration');
const chores = require('./familyChores');
const work = require('./connectors/work');
const emailTriage = require('./emailTriage');

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
  const [calendarData, recovery, sleep, strain, activity, familyChores, jira, slack, emailTriageData] = await Promise.all([
    provider('google_calendar', async () => {
      const result = await calendar.collectEvents(profileId, { days: 7, maxResults: 25 });
      const timeZone = calendar.displayTimeZone(result.calendars);
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const date = Object.fromEntries(parts.map(p => [p.type, p.value]));
      const today = `${date.year}-${date.month}-${date.day}`;
      // Keep ongoing events, discard events that already ended. All-day end
      // dates are exclusive calendar dates, not UTC timestamps.
      const events = result.events.filter(e => e.allDay
        ? (e.end || e.start) > today || (!e.end && e.start === today)
        : new Date(e.end || e.start).getTime() > Date.now());
      return { events, timeZone, days: 7 };
    }),
    // Recovery and cycles reach back a fortnight, not a week: the resting
    // heart rate and HRV they carry only mean anything against a baseline, and
    // a baseline built from the three or four days either side of today moves
    // with whatever it is supposed to be measuring. The panels still draw the
    // last seven; the extra days exist to be compared against.
    provider('whoop', () => whoop.listRecovery(profileId, { days: 14, limit: 14 }), true),
    provider('whoop', () => whoop.listSleep(profileId, { days: 7, limit: 7 }), true),
    provider('whoop', () => whoop.listCycles(profileId, { days: 14, limit: 14 }), true),
    provider('strava', async () => ({ activities: await strava.listActivities(profileId, { days: 7, perPage: 30 }), days: 7 }), true),
    (async () => {
      try {
        const status = await integration.getStatus(user, integration.PROVIDER_FAMILY_CHORES);
        if (!status.connected) return section('not_connected');
        const creds = await integration.getUsableCredentials(profileId);
        if (!creds?.playerId) return section('error');
        return read(async () => ({
          name: creds.displayName,
          chores: (await chores.getChoresToday(creds.playerId, { token: creds.token, baseUrl: creds.baseUrl }))
            .slice(0, 25).map(c => ({ title: c.title || 'Untitled chore', status: c.status || null, completed: !!c.completedAt, dueDate: c.dueDate || null })),
        }));
      } catch { return section('error'); }
    })(),
    provider('jira', () => work.jira(profileId)),
    provider('slack', () => work.slack(profileId)),
    // Gated on the 'gmail' credential like every other provider() call here,
    // but the data behind it is now the triage summary (see services/emailTriage.js),
    // not the old "5 unread subjects" work.gmail() reader.
    provider('gmail', () => emailTriage.summary(profileId)),
  ]);
  const result = { calendar: calendarData, recovery, sleep, strain, activity, familyChores, jira, slack, emailTriage: emailTriageData };
  for (const [id, entry] of snapshots) if (Date.now() - entry.at >= CACHE_TTL_MS) snapshots.delete(id);
  if (snapshots.size >= 128) snapshots.delete(snapshots.keys().next().value);
  snapshots.set(profileId, { at: Date.now(), data: result });
  return result;
}
module.exports = { getDashboard, cachedDashboard };
