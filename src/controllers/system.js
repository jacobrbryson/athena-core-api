const { requireAdultActor } = require('../helpers/actor');
const twilioBilling = require('../services/twilioBilling');

async function twilioBillingStatus(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json(await twilioBilling.getBilling());
  } catch (err) {
    console.warn('[system] Twilio billing unavailable:', err?.message || err);
    return res.status(503).json({ success: false, message: 'Twilio billing data is unavailable. Please retry.' });
  }
}

module.exports = { twilioBillingStatus };
