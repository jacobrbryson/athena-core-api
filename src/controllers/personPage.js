const { requireAdultActor } = require("../helpers/actor");
const personPage = require("../services/personPage");

/** No caching, an adult actor, and the service's own status on a refusal. */
function handler(run) {
	return async (req, res) => {
		res.set("Cache-Control", "no-store");
		const actor = await requireAdultActor(req, res);
		if (!actor) return;
		try {
			return res.json(await run(actor.profileId, req));
		} catch (err) {
			if (!err.status) console.warn("[personPage]", err.message);
			return res.status(err.status || 500).json({ success: false, message: err.status ? err.message : "Could not read that person." });
		}
	};
}

const body = (req) => req.body || {};

module.exports = {
	read: handler((id, req) => personPage.read(id, req.params.key, { names: req.query.names })),
	saveAbout: handler((id, req) => personPage.saveAbout(id, req.params.key, body(req))),
	addInterest: handler((id, req) => personPage.addInterest(id, req.params.key, body(req))),
	removeInterest: handler((id, req) => personPage.removeInterest(id, req.params.key, req.params.uuid, { names: req.query.names })),
	addRelated: handler((id, req) => personPage.addRelated(id, req.params.key, body(req))),
	removeRelated: handler((id, req) => personPage.removeRelated(id, req.params.key, req.params.uuid, { names: req.query.names })),
};
