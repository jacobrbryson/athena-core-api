const { requireAdultActor } = require('../helpers/actor');
const billScan = require('../services/billScan');

// Scan a bill (docs/capabilities/property-taxes.md, vehicles.md). Adult-only.
// A scan reads the photo and answers with ONE proposal card, or with what it
// needs from the person first; nothing is written until they approve the card
// through the ordinary /api/v1/actions/:uuid/confirm. The photo is not kept.
const handler = (what, fn) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    const result = await fn(actor.profileId, req.body || {});
    if (result.status === 'not_a_bill') return res.status(422).json({ message: "That doesn't look like a vehicle registration, a property tax bill or a vehicle notice." });
    return res.json(result);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ message: "Bill scanning isn't set up on this server yet." });
    if ([400, 404, 422].includes(err.status)) return res.status(err.status).json({ message: err.message });
    console.error(`[bills] could not ${what}:`, err.message);
    return res.status(500).json({ message: `Athena could not ${what}. Try again, or add it by hand.` });
  }
};

const scan = handler('read that bill', (profileId, body) => billScan.scan(profileId, body));
const review = handler('use those details', (profileId, body) => billScan.review(profileId, body));

module.exports = { scan, review };
