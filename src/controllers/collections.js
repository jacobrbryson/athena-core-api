/**
 * Collections in the app (services/collections). Reads, plus the person's own
 * taps: tick someone off, keep a suggestion, change a status, remove (with
 * undo). Chat changes go through the action layer instead; a tap here is the
 * person's own decision, like every other edit on their pages.
 */
const { requireAdultActor } = require("../helpers/actor");
const collections = require("../services/collections");

function handler(run) {
	return async (req, res) => {
		res.set("Cache-Control", "no-store");
		const actor = await requireAdultActor(req, res);
		if (!actor) return;
		try {
			return res.json(await run(actor.profileId, req));
		} catch (err) {
			if (!err.status) console.warn("[collections]", err.message);
			return res.status(err.status || 500).json({ success: false, message: err.status ? err.message : "Could not read your lists." });
		}
	};
}

const body = (req) => req.body || {};

module.exports = {
	overview: handler((id) => collections.overview(id)),
	detail: handler((id, req) => collections.detail(id, req.params.uuid)),
	forPerson: handler((id, req) => collections.forPerson(id, req.params.key)),
	setDone: handler(async (id, req) => {
		await collections.setSubjectDone(id, req.params.uuid, body(req).done !== false);
		return { success: true };
	}),
	updateItem: handler(async (id, req) => {
		const { status, title } = body(req);
		await collections.updateItem(id, req.params.uuid, {
			status: typeof status === "string" ? status : null,
			title: typeof title === "string" ? title : null,
		});
		return { success: true };
	}),
	removeItem: handler(async (id, req) => {
		await collections.removeItem(id, req.params.uuid);
		return { success: true };
	}),
	restoreItem: handler(async (id, req) => {
		await collections.restoreItem(id, req.params.uuid);
		return { success: true };
	}),
};
