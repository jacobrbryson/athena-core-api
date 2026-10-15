const { requireAdultActor } = require("../helpers/actor");
const healthPlan = require("../services/healthPlan");
const foodScan = require("../services/foodScan");

/**
 * The Health page's plan: training program, nutrition targets and food log.
 * Adult-only; every call reads or writes the caller's own rows.
 */

function failed(res, err, what) {
	// ER_BAD_FIELD_ERROR: 0073 is in but 0074 (food sources, favorites) isn't yet.
	if (err.code === "ER_NO_SUCH_TABLE" || err.code === "ER_BAD_FIELD_ERROR") return res.status(503).json({ success: false, message: "Training and nutrition aren't set up on this server yet." });
	if (err.status) return res.status(err.status).json({ success: false, message: err.message });
	console.error(`[healthPlan] ${what} failed:`, err.message);
	return res.status(500).json({ success: false, message: `Could not ${what}.` });
}

/** Wraps a handler: no-store, adult actor resolved, errors mapped. */
const handler = (what, fn) => async (req, res) => {
	res.set("Cache-Control", "no-store");
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		return await fn(actor.profileId, req, res);
	} catch (err) {
		return failed(res, err, what);
	}
};

module.exports = {
	overview: handler("load your plan", async (profileId, req, res) => res.json(await healthPlan.overview(profileId, { today: req.query.today }))),
	saveProgram: handler("save that program", async (profileId, req, res) => {
		await healthPlan.saveProgram(profileId, req.body || {});
		return res.status(201).json({ program: await healthPlan.program(profileId, { today: req.body?.today }) });
	}),
	endProgram: handler("end that program", async (profileId, req, res) => res.json({ ended: await healthPlan.endProgram(profileId) })),
	markSession: handler("mark that session", async (profileId, req, res) => {
		const status = req.body?.status === undefined ? null : req.body.status;
		if (!(await healthPlan.markSession(profileId, req.params.uuid, { date: req.body?.date, status }))) return res.status(404).json({ success: false, message: "Not found." });
		return res.json({ program: await healthPlan.program(profileId, { today: req.body?.today }) });
	}),
	saveTargets: handler("save those targets", async (profileId, req, res) => res.json({ targets: await healthPlan.saveTargets(profileId, req.body || {}) })),
	addEntry: handler("log that", async (profileId, req, res) => {
		await healthPlan.addEntry(profileId, req.body || {});
		return res.status(201).json({ nutrition: await healthPlan.nutrition(profileId, { today: req.body?.today || req.body?.eaten_on }) });
	}),
	/** One day's food log, for paging back through past days. Never ahead of the person's today. */
	day: handler("load that day", async (profileId, req, res) => {
		const { date, today } = req.query;
		if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return res.status(400).json({ success: false, message: "A date (YYYY-MM-DD) is required." });
		if (typeof today === "string" && date > today) return res.status(400).json({ success: false, message: "That day hasn't happened yet." });
		return res.json({ nutrition: await healthPlan.nutrition(profileId, { today: date }) });
	}),
	updateEntry: handler("save that", async (profileId, req, res) => {
		if (!(await healthPlan.updateEntry(profileId, req.params.uuid, req.body || {}))) return res.status(404).json({ success: false, message: "Not found." });
		return res.json({ nutrition: await healthPlan.nutrition(profileId, { today: req.body?.today }) });
	}),
	scan: handler("look at that", async (profileId, req, res) => {
		const { entry, how, note } = await foodScan.scan(profileId, req.body || {});
		return res.status(201).json({ entry, how, note, nutrition: await healthPlan.nutrition(profileId, { today: req.body?.today || req.body?.eaten_on }) });
	}),
	saveFavorite: handler("star that", async (profileId, req, res) => {
		await healthPlan.saveFavorite(profileId, req.body || {});
		return res.status(201).json({ nutrition: await healthPlan.nutrition(profileId, { today: req.body?.today }) });
	}),
	removeFavorite: handler("unstar that", async (profileId, req, res) => {
		if (!(await healthPlan.removeFavorite(profileId, req.params.uuid))) return res.status(404).json({ success: false, message: "Not found." });
		return res.json({ nutrition: await healthPlan.nutrition(profileId, { today: req.query.today }) });
	}),
	logFavorite: handler("log that", async (profileId, req, res) => {
		if (!(await healthPlan.logFavorite(profileId, req.params.uuid, { eaten_on: req.body?.eaten_on }))) return res.status(404).json({ success: false, message: "Not found." });
		return res.status(201).json({ nutrition: await healthPlan.nutrition(profileId, { today: req.body?.today || req.body?.eaten_on }) });
	}),
	removeEntry: handler("remove that", async (profileId, req, res) => {
		if (!(await healthPlan.removeEntry(profileId, req.params.uuid))) return res.status(404).json({ success: false, message: "Not found." });
		return res.json({ nutrition: await healthPlan.nutrition(profileId, { today: req.query.today }) });
	}),
};
