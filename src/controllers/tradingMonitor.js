const dispatch = require('../services/guardianEngine/dispatch');
const monitor = require('../services/trading/monitor');

/**
 * POST /internal/trading/tick — not a person's route. Cloud Tasks (the
 * monitor's own chain) and the athena-incidents job call it with a
 * Google-signed ID token for an allowed service account. The body's only
 * field is `reason`; nothing in it selects a person, a symbol or an action.
 */
async function tick(req, res, { verify = dispatch.verifyCaller, run = monitor.tick } = {}) {
  res.set('Cache-Control', 'no-store');
  if (!(await verify(req))) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const out = await run({ reason: req.body?.reason === 'backstop' ? 'backstop' : 'tick' });
    return res.json({
      skipped: out.skipped || null,
      phase: out.phase || null,
      profiles: out.profiles ?? 0,
      next_booked: out.next_booked ?? null,
      results: (out.results || []).map(r => ({ created: r.created || 0, sent: r.sent || 0, lapsed: r.lapsed || 0, held: r.held || 0, failed: r.failed || 0, error: r.error ? 'failed' : null })),
    });
  } catch (error) {
    console.error('[trading] monitor tick failed', { message: error?.message });
    // 503 lets Cloud Tasks retry; the incidents job restarts a broken chain.
    return res.status(503).json({ message: 'Trading monitor tick failed' });
  }
}

module.exports = { tick: (req, res) => tick(req, res), tickWith: tick };
