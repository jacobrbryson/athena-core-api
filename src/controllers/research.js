const { requireAdultActor } = require('../helpers/actor');

// The Research page (docs/capabilities/research.md): every study for the
// signed-in adult, in one read. Studies fail one at a time, never together.
async function list(req, res) {
	res.set('Cache-Control', 'no-store');
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		return res.json({ studies: await require('../services/research').list(actor.profileId, { fresh: req.query.fresh === '1' }) });
	} catch (err) {
		console.error('[research] list failed', { code: err?.code || null, message: err?.message });
		return res.status(503).json({ message: 'Research is unavailable right now.' });
	}
}

module.exports = { list };
