/**
 * The Dreams log for the companion app. Adult accounts only; read-only.
 * Missing tables (migration 0046 not applied yet) read as "no dreams", not
 * as an error, so the dashboard section can simply say she hasn't dreamed.
 */
const { requireAdultActor } = require("../helpers/actor");
const log = require("../services/dreams/log");

const NOT_YET = "ER_NO_SUCH_TABLE";

async function guarded(req, res, fn, empty) {
	res.set("Cache-Control", "no-store");
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		return res.json(await fn(actor));
	} catch (err) {
		if (err?.code === NOT_YET) return res.json(empty);
		if (err?.status === 404) return res.status(404).json({ success: false, message: "Unknown dream" });
		console.warn("[dreams]", err?.message || err);
		return res.status(503).json({ success: false, message: "The Dreams log is unavailable. Please retry." });
	}
}

const list = (req, res) => guarded(req, res, async () => ({ dreams: await log.list() }), { dreams: [] });
const latest = (req, res) => guarded(req, res, async () => ({ dream: await log.latest() }), { dream: null });
const questions = (req, res) =>
	guarded(req, res, async (actor) => ({ questions: await log.questionsFor(actor.profileId) }), { questions: [] });

async function night(req, res) {
	if (!/^[0-9a-f-]{36}$/i.test(String(req.params.uuid || ""))) {
		return res.status(400).json({ success: false, message: "Unknown dream" });
	}
	return guarded(
		req,
		res,
		async (actor) => {
			const found = await log.night(req.params.uuid, { viewerProfileId: actor.profileId });
			if (!found) throw Object.assign(new Error("not found"), { status: 404 });
			return { dream: found };
		},
		{ dream: null }
	);
}

/** The dream's picture, streamed from the private bucket. */
async function picture(req, res) {
	if (!/^[0-9a-f-]{36}$/i.test(String(req.params.uuid || ""))) return res.status(404).end();
	const actor = await requireAdultActor(req, res);
	if (!actor) return;
	try {
		const path = await log.imagePath(req.params.uuid);
		if (!path) return res.status(404).end();
		const { file, contentType } = require("../services/dreams/image").open(path);
		res.set("Content-Type", contentType);
		res.set("Cache-Control", "private, max-age=86400");
		file
			.createReadStream()
			.on("error", (err) => {
				// Past the bucket's 30-day lifecycle the object is simply gone.
				if (!res.headersSent) res.status(err?.code === 404 ? 404 : 503).end();
				else res.destroy(err);
			})
			.pipe(res);
	} catch (err) {
		if (err?.code === NOT_YET || err?.status === 404) return res.status(404).end();
		console.warn("[dreams] image", err?.message || err);
		return res.status(503).end();
	}
}

module.exports = { list, latest, night, questions, picture };
