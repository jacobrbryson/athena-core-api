const { requireAdultActor } = require('../helpers/actor');
const twilioBilling = require('../services/twilioBilling');
const openaiBilling = require('../services/openaiBilling');
const gcpBilling = require('../services/gcpBilling');

/** One read-only provider view per route, so one provider failing never blanks the others. */
function billingStatus(label, service) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const actor = await requireAdultActor(req, res);
    if (!actor) return;
    try {
      return res.json(await service.getBilling());
    } catch (err) {
      console.warn(`[system] ${label} billing unavailable:`, err?.message || err);
      return res.status(503).json({ success: false, message: `${label} billing data is unavailable. Please retry.` });
    }
  };
}

module.exports = {
  twilioBillingStatus: billingStatus('Twilio', twilioBilling),
  openaiBillingStatus: billingStatus('OpenAI', openaiBilling),
  gcpBillingStatus: billingStatus('GCP', gcpBilling),
};
