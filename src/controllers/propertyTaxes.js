const { requireAdultActor } = require('../helpers/actor');
const records = require('../services/billRecords');

// Property taxes (docs/capabilities/property-taxes.md): the records a scanned
// bill creates, with each installment's due date. Adult-only, profile-scoped;
// every write answers with the whole list. The person's own taps live here —
// marking a payment paid or unpaid, removing a record. Creating one is the
// bill scan's approved action.
const day = v => {
  if (typeof v !== 'string' || !records.isDay(v)) throw Object.assign(new Error('Enter a valid date.'), { status: 400 });
  return v;
};
const handler = fn => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const actor = await requireAdultActor(req, res);
  if (!actor) return;
  try {
    res.json(await fn(actor.profileId, req));
  } catch (err) {
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ message: err.message });
    return res.status(503).json({ message: 'Taxes are unavailable. Please try again; the taxes migration must be installed.' });
  }
};
const notFound = () => Object.assign(new Error('That tax record is no longer on your list.'), { status: 404 });

const list = handler(async profileId => ({ taxes: await records.listTaxes(profileId) }));

// { paidOn: 'YYYY-MM-DD' } marks it paid; { paidOn: null } puts it back to unpaid.
const setPaid = handler(async (profileId, req) => {
  const paidOn = req.body?.paidOn === null ? null : day(req.body?.paidOn);
  if (!(await records.setInstallmentPaid(profileId, req.params.uuid, req.params.installmentUuid, paidOn))) throw notFound();
  return { taxes: await records.listTaxes(profileId) };
});

const remove = handler(async (profileId, req) => {
  if (!(await records.removeTax(profileId, req.params.uuid))) throw notFound();
  return { taxes: await records.listTaxes(profileId) };
});

module.exports = { list, setPaid, remove };
