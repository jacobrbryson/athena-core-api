const { requireAdultActor } = require('../helpers/actor');
const twilioBilling = require('../services/twilioBilling');
const openaiBilling = require('../services/openaiBilling');
const gcpBilling = require('../services/gcpBilling');
const systemHealth = require('../services/systemHealth');
const timeSaved = require('../services/timeSaved');

/** One read-only view per route, so one provider failing never blanks the others. */
function systemRead(label, read) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    try {
      return res.json(await read());
    } catch (err) {
      console.warn(`[system] ${label} unavailable:`, err?.message || err);
      return res.status(503).json({ success: false, message: `${label} data is unavailable. Please retry.` });
    }
  };
}

/** Unlike the billing reads, this one is the caller's own: their actions, their minutes. */
async function timeSavedStatus(req, res) {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    return res.json(await timeSaved.getTimeSaved(actor.profileId));
  } catch (err) {
    console.warn('[system] Time saved unavailable:', err?.message || err);
    return res.status(503).json({ success: false, message: 'Time saved data is unavailable. Please retry.' });
  }
}

module.exports = {
  timeSavedStatus,
  twilioBillingStatus: systemRead('Twilio billing', () => twilioBilling.getBilling()),
  openaiBillingStatus: systemRead('OpenAI billing', () => openaiBilling.getBilling()),
  gcpBillingStatus: systemRead('GCP billing', () => gcpBilling.getBilling()),
  healthStatus: systemRead('Health', () => systemHealth.getHealth()),
};
