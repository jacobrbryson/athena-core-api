const { requireAdultActor } = require("../helpers/actor");
const familyHealth = require("../services/familyHealth");

/** Every handler: no caching, an adult actor, and the service's own status on a refusal. */
function handler(run, { created = false, fallback = "Could not update that." } = {}) {
	return async (req, res) => {
		res.set("Cache-Control", "no-store");
		const actor = await requireAdultActor(req, res);
		if (!actor) return;
		try {
			const out = await run(actor.profileId, req);
			if (out === null) return res.status(404).json({ success: false, message: "Not found." });
			return res.status(created ? 201 : 200).json(out);
		} catch (err) {
			if (!err.status) console.warn("[familyHealth]", err.message);
			return res.status(err.status || 500).json({ success: false, message: err.status ? err.message : fallback });
		}
	};
}

const body = (req) => req.body || {};

module.exports = {
	report: handler(async (id, req) => ({ status: await familyHealth.report(id, body(req)) }), { created: true, fallback: "Could not save that." }),
	resolve: handler(async (id, req) => {
		const status = await familyHealth.resolve(id, req.params.uuid);
		return status ? { status } : null;
	}),
	detail: handler((id, req) => familyHealth.detail(id, req.params.uuid), { fallback: "Could not read that watch." }),
	edit: handler((id, req) => familyHealth.edit(id, req.params.uuid, body(req))),
	addUpdate: handler((id, req) => familyHealth.addUpdate(id, req.params.uuid, body(req)), { created: true }),
	removeEntry: handler((id, req) => familyHealth.removeEntry(id, req.params.uuid, req.params.entry)),
	addCheck: handler((id, req) => familyHealth.addCheck(id, req.params.uuid, body(req)), { created: true }),
	updateCheck: handler((id, req) => familyHealth.updateCheck(id, req.params.uuid, req.params.check, body(req))),
	removeCheck: handler((id, req) => familyHealth.removeCheck(id, req.params.uuid, req.params.check)),
	markCheck: handler((id, req) => familyHealth.markCheck(id, req.params.uuid, req.params.check, body(req))),
};
