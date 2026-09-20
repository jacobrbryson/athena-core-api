const pool = require('../../helpers/db');
const credentials = require('../credentials');
const consent = require('../consent');
const audience = require('../audience');
const whoop = require('../connectors/whoop');
const calendar = require('../connectors/googleCalendar');
const store = require('./store');

const SOURCE = 'whoop_workout';
const unavailable = code => Object.assign(new Error(code), { code, status: 409 });

async function authorize(w) {
  if (!w?.enabled) throw unavailable('attention_paused');
  if (await audience.audienceForProfile(w.profile_id) !== 'adult') throw unavailable('adult_required');
  if (!await consent.hasConsentForProfile(w.profile_id, 'health_data')) throw unavailable('health_consent_required');
  const links = await credentials.list(w.profile_id);
  const active = links.filter(l => l.provider === 'whoop' && l.status === 'active');
  if (active.length !== 1 || active[0].uuid !== w.credential_uuid || active[0].external_account_id !== w.external_account_id) {
    throw unavailable('whoop_connection_changed');
  }
  const calendars = links.filter(l => l.provider === 'google_calendar' && l.status === 'active');
  if (calendars.length !== 1) throw unavailable('calendar_connection_required');
  return { calendarCredential: calendars[0].uuid };
}

async function observe(w, event) {
  let workout;
  try { workout = await whoop.getWorkout(w.profile_id, event.resource_id); }
  catch (error) {
    if (error.providerStatus === 404) {
      // Read the source even for delete deliveries: an old, delayed delete
      // must not erase a resource which the provider currently returns.
      return { source: SOURCE, id: event.resource_id, state: event.event_type === 'workout.deleted' ? 'deleted' : 'not_found', label: null };
    }
    throw error;
  }
  if (String(workout.user_id) !== w.external_account_id || workout.id !== event.resource_id) throw unavailable('source_identity_mismatch');
  if (!workout.start || !workout.end || !Number.isFinite(Date.parse(workout.start)) || !Number.isFinite(Date.parse(workout.end))) throw unavailable('incomplete_workout');
  return { source: SOURCE, id: workout.id, state: 'present', label: String(workout.sport), start: workout.start, end: workout.end, data: workout };
}

function chooseFacts(facts, observation, events) {
  // This chooses context, not outcomes. Names, event titles and source text
  // guide retrieval without any sport/occupation-specific conditions.
  const tokens = new Set(`${observation.label} ${events.map(e => `${e.title} ${e.description}`).join(' ')}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  return [...facts].sort((a, b) => {
    const score = f => (String(`${f.memory_key} ${f.memory_value}`).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(t => tokens.has(t)).length;
    return score(b) - score(a);
  }).slice(0, 50);
}

async function context(w, observation, authorization) {
  const [{ events }, factsResult, corrected] = await Promise.all([
    calendar.eventsInInterval(w.profile_id, { start: observation.start, end: observation.end }),
    pool.query(`SELECT uuid, category, memory_key, memory_value, source, updated_at FROM user_memory
      WHERE profile_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`, [w.profile_id]),
    store.corrections(w.id),
  ]);
  const evidence = [{ id: 'observation', kind: 'provider_report', value: observation }];
  for (const e of events.sort((a, b) => `${a.calendar_id}/${a.id}`.localeCompare(`${b.calendar_id}/${b.id}`))) {
    evidence.push({ id: `calendar:${e.calendar_id}:${e.id}`, kind: 'scheduled_event', value: e });
  }
  for (const f of chooseFacts(factsResult[0], observation, events)) {
    evidence.push({ id: `memory:${f.uuid}`, kind: 'memory', value: { category: f.category, key: f.memory_key, text: f.memory_value, source: f.source, updated_at: f.updated_at } });
  }
  const seen = new Set();
  for (const c of corrected) {
    if (seen.has(c.resource_id)) continue;
    seen.add(c.resource_id);
    evidence.push({ id: `correction:${c.uuid}`, kind: 'human_correction', value: { original: c.payload.observation, correction: c.feedback, at: c.feedback_at } });
  }
  const mostRecent = corrected.find(c => c.resource_id === observation.id);
  const own = mostRecent?.observation_hash === store.hash(observation) ? mostRecent : null;
  return { evidence, calendarCredential: authorization.calendarCredential, ownCorrection: own ? { uuid: own.uuid, ...own.feedback } : null,
    factsConsidered: factsResult[0].length, factsIncluded: Math.min(factsResult[0].length, 50) };
}

async function sync(w) {
  const state = store.parse(w.sync_state) || {
    round: require('node:crypto').randomUUID(), start: new Date(Date.now() - 7 * 86400000).toISOString(), end: new Date().toISOString(), nextToken: null,
  };
  // Verify the actual token's account, rather than trusting a saved label.
  const profile = await whoop.getProfile(w.profile_id);
  if (String(profile?.user_id) !== w.external_account_id) throw unavailable('source_identity_mismatch');
  const page = await whoop.workoutPage(w.profile_id, state);
  if (page.nextToken && page.nextToken === state.nextToken) throw unavailable('source_pagination_stalled');
  if (page.records.some(r => String(r.user_id) !== w.external_account_id || !/^[a-f0-9-]{36}$/i.test(r.id))) throw unavailable('source_identity_mismatch');
  const entries = page.records.map(r => ({ key: ['sync', state.round, r.id], resourceId: r.id, type: 'reconcile' }));
  if (!page.nextToken) {
    // Revisit known resources too, so a deleted activity need not remain
    // present forever when its delete webhook was missed.
    const [known] = await pool.query(`SELECT DISTINCT resource_id FROM attention_record WHERE watch_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`, [w.id]);
    entries.push(...known.map(r => ({ key: ['sync', state.round, r.resource_id], resourceId: r.resource_id, type: 'reconcile' })));
  }
  return { entries, nextState: page.nextToken ? { ...state, nextToken: page.nextToken } : null };
}

module.exports = { SOURCE, authorize, observe, context, sync, chooseFacts };
