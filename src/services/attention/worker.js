const pool = require('../../helpers/db');
const access = require('../../security/access');
const store = require('./store');
const { interpret, VERSION } = require('./interpret');
const sources = { whoop_workout: require('./whoop') };

// Each source supplies reads and context; interpretation and durable execution
// are shared. Adding a new kind of personal situation does not add a handler.
async function processEvent(w, event, source) {
  const authorization = await source.authorize(w);
  const observation = await source.observe(w, event);
  const observationHash = store.hash(observation);
  const previous = await store.latest(w.id, event.resource_id);
  let context = { evidence: [] }, interpretation;
  if (observation.state !== 'present') {
    interpretation = { status: observation.state, label: null, reason: 'The source no longer returns this activity.', evidence_ids: [], alternatives: [] };
  } else {
    context = await source.context(w, observation, authorization);
  }
  const contextHash = store.hash({ version: VERSION, context });
  if (previous?.observation_hash === observationHash && previous.context_hash === contextHash) {
    await source.authorize(w);
    return store.complete(w, event, { disposition: 'unchanged' });
  }
  if (observation.state === 'present') {
    if (context.ownCorrection) {
      interpretation = { status: 'confirmed', label: context.ownCorrection.label,
        reason: context.ownCorrection.note || 'You confirmed this activity.',
        evidence_ids: [`correction:${context.ownCorrection.uuid}`], alternatives: [], version: VERSION };
    } else interpretation = await interpret(observation, context.evidence);
  }
  // Revocation during an API/model round trip must stop publication, too.
  await source.authorize(w);
  await access.assertModelAccess();
  return store.complete(w, event, { observationHash, contextHash, payload: {
    observation, context, interpretation, evaluated_at: new Date().toISOString(),
  }, disposition: observation.state === 'present' ? 'interpreted' : observation.state });
}

function errorCode(error) {
  const known = ['attention_paused', 'adult_required', 'health_consent_required', 'whoop_connection_changed',
    'calendar_connection_required', 'source_identity_mismatch', 'incomplete_workout', 'source_pagination_stalled', 'ACCESS_REQUIRED'];
  return known.includes(error?.code) ? error.code : 'processing_failed';
}

async function runOnce({ watchLimit = 20, eventLimit = 20 } = {}) {
  const report = { watches: 0, processed: 0, retried: 0, failed: 0 };
  for (const candidate of await store.dueWatches(watchLimit)) {
    const w = await store.claim(candidate);
    if (!w) continue;
    report.watches++;
    let failure = null;
    try {
      const [profiles] = await pool.query('SELECT google_id FROM profile WHERE id = ?', [w.profile_id]);
      const identity = profiles[0]?.google_id ? { google_id: profiles[0].google_id } : null;
      await access.context.run({ identity }, async () => {
        await access.assertModelAccess();
        const source = sources[w.source];
        if (!source) throw new Error('Unsupported attention source');
        await source.authorize(w);
        if (new Date(w.next_sync_at).getTime() <= Date.now()) {
          const { entries, nextState } = await source.sync(w);
          await source.authorize(w);
          await store.syncPage(w, entries, nextState);
        }
        for (let i = 0; i < eventLimit; i++) {
          const event = await store.nextEvent(w);
          if (!event) break;
          try { await processEvent(w, event, source); report.processed++; }
          catch (error) {
            if (error.code === 'lease_lost') throw error;
            await store.retry(w, event, errorCode(error));
            report.retried++;
          }
        }
      });
    } catch (error) { failure = errorCode(error); report.failed++; }
    finally { await store.release(w, failure); }
  }
  return report;
}

module.exports = { processEvent, runOnce, errorCode };
