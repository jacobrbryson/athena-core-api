/**
 * HTTP handlers for the Companion platform: long-term memory (v2), the model
 * router's status + device manifest, paired devices, and camera perception.
 */
const memoryStore = require("../services/memoryStore");
const perception = require("../services/perception");
const devices = require("../services/devices");
const push = require("../services/push");
const llm = require("../services/llm");
const { resolveActor, requireAdultActor } = require("../helpers/actor");
const lookRequests = require("../services/lookRequests");

function fail(res, err, fallback) {
	const status = err.status || (/not found/i.test(err.message) ? 404 : /required|invalid|too large|must be/i.test(err.message) ? 400 : 500);
	if (status >= 500) console.error(`[companion] ${fallback}:`, err.message);
	return res.status(status).json({ success: false, message: status >= 500 ? fallback : err.message });
}

// ---------------------------------------------------------------------------
// Memory v2
// ---------------------------------------------------------------------------

/** GET /memory/recall?q=… — "what do you remember about X", ranked. */
async function recall(req, res) {
	try {
		const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 300) : "";
		if (!q) return res.status(400).json({ success: false, message: "A query is required" });
		const who = await resolveActor(req);
		if (!(await memoryStore.memoryEnabledForProfile(who.profileId))) {
			return res.json({ intent: false, items: [], disabled: true });
		}
		const k = Math.min(Math.max(Number(req.query.k) || 10, 1), 25);
		const result = await memoryStore.recall(who.profileId, q, {
			k,
			intent: true,
			tz: typeof req.query.tz === "string" ? req.query.tz : undefined,
			includeTranscripts: who.audience === "adult",
		});
		return res.json(result);
	} catch (err) {
		return fail(res, err, "Failed to search memory");
	}
}

/** GET /memory/events?kind=&limit=&before= */
async function listEvents(req, res) {
	try {
		const who = await resolveActor(req);
		return res.json(
			await memoryStore.listEvents(who.profileId, {
				kind: req.query.kind,
				limit: req.query.limit,
				before: req.query.before,
			})
		);
	} catch (err) {
		return fail(res, err, "Failed to load memories");
	}
}

/** POST /memory/events — "remember this" (a moment the person asked Athena to keep). */
async function createEvent(req, res) {
	try {
		const who = await resolveActor(req);
		const body = req.body || {};
		const event = await memoryStore.createEvent(
			{
				profileId: who.profileId,
				familyId: who.familyId,
				kind: "event",
				title: body.title,
				content: body.content,
				occurredAt: body.occurred_at,
				importance: body.importance ?? 7,
				source: "user",
				visibility: body.visibility === "family" ? "family" : "private",
			},
			{ awaitEmbedding: true }
		);
		return res.status(201).json({ success: true, event });
	} catch (err) {
		return fail(res, err, "Failed to save memory");
	}
}

/** DELETE /memory/events/:uuid */
async function deleteEvent(req, res) {
	try {
		const who = await resolveActor(req);
		return res.json(await memoryStore.deleteEvent(who.profileId, req.params.uuid));
	} catch (err) {
		return fail(res, err, "Failed to delete memory");
	}
}

/** POST /memory/photos — adult only; the image is described, never stored. */
async function rememberPhoto(req, res) {
	const who = await requireAdultActor(req, res);
	if (!who) return;
	try {
		const body = req.body || {};
		const event = await memoryStore.rememberPhoto(who.profileId, who.familyId, {
			imageBase64: body.imageBase64,
			mimeType: body.mimeType,
			caption: body.caption,
			takenAt: body.takenAt,
			mediaRef: body.mediaRef,
			place: body.place,
		});
		return res.status(201).json({ success: true, event });
	} catch (err) {
		return fail(res, err, "Athena couldn't look at that photo right now");
	}
}

/** GET /memory/journal — Markdown of everything Athena remembers. */
async function journal(req, res) {
	try {
		const who = await resolveActor(req);
		const name = typeof req.user?.tokenPayload?.full_name === "string" ? req.user.tokenPayload.full_name.split(/\s+/)[0] : null;
		const md = await memoryStore.renderJournal(who.profileId, { displayName: name });
		res.set("Content-Type", "text/markdown; charset=utf-8");
		res.set("Cache-Control", "no-store");
		return res.send(md);
	} catch (err) {
		return fail(res, err, "Failed to render journal");
	}
}

// ---------------------------------------------------------------------------
// Model router
// ---------------------------------------------------------------------------

/** GET /llm/status — which tier is serving, endpoint health, recent calls. */
async function llmStatus(req, res) {
	const status = llm.status();
	// Error strings can carry internal hostnames — adults see the summary only.
	return res.json({
		...status,
		orcwood: status.orcwood.map((e) => ({ ...e, health: { ...e.health, lastError: e.health.lastError ? "error" : null } })),
		frontier: status.frontier.map((e) => ({ ...e, health: { ...e.health, lastError: e.health.lastError ? "error" : null } })),
		recentCalls: status.recentCalls.map(({ error, ...c }) => c),
	});
}

/** GET /llm/manifest — public: which on-device models to run (no secrets). */
function llmManifest(req, res) {
	res.set("Cache-Control", "public, max-age=300");
	return res.json(llm.manifest());
}

/**
 * POST /devices/push-token — a device says where it can be reached.
 *
 * Device-authenticated only. The Companion app cannot register on a handset's
 * behalf: only the handset knows its own FCM registration, and only it can
 * tell when that registration has been replaced. Re-registering is the normal
 * case, not an error — the client is expected to send its current token on
 * every launch.
 */
async function registerPushToken(req, res) {
	if (req.user?.kind !== "device") {
		return res.status(403).json({ success: false, message: "Device token required" });
	}
	try {
		const result = await push.registerToken(req.user.deviceId, req.body?.token, {
			provider: req.body?.provider || "fcm",
		});
		return res.json({ success: true, ...result });
	} catch (err) {
		return fail(res, err, "Failed to register for notifications");
	}
}

/** DELETE /devices/push-token — notifications turned off on the handset. */
async function forgetPushToken(req, res) {
	if (req.user?.kind !== "device") {
		return res.status(403).json({ success: false, message: "Device token required" });
	}
	try {
		return res.json({ success: true, ...(await push.forgetToken(req.user.deviceId)) });
	} catch (err) {
		return fail(res, err, "Failed to turn off notifications");
	}
}

/** POST /llm/device-report — a paired device reports what it now runs. */
async function deviceReport(req, res) {
	if (req.user?.kind !== "device") {
		return res.status(403).json({ success: false, message: "Device token required" });
	}
	try {
		const caps = await devices.recordCapabilities(req.user.deviceId, req.body || {});
		return res.json({ success: true, capabilities: caps, manifestVersion: llm.manifest().version });
	} catch (err) {
		return fail(res, err, "Failed to record device report");
	}
}

// ---------------------------------------------------------------------------
// Paired devices
// ---------------------------------------------------------------------------

async function createPairingCode(req, res) {
	if (req.user?.kind === "device") {
		return res.status(403).json({ success: false, message: "Pair new devices from the Companion app" });
	}
	const who = await requireAdultActor(req, res);
	if (!who) return;
	try {
		return res.status(201).json(await devices.createPairingCode(who.profileId, req.body || {}));
	} catch (err) {
		return fail(res, err, "Failed to create a pairing code");
	}
}

/** POST /devices/pair — public; the code is the credential. */
async function redeemPairingCode(req, res) {
	try {
		const paired = await devices.redeemPairingCode(req.body?.code, req.body || {});
		if (!paired) {
			return res.status(401).json({ success: false, message: "That pairing code is invalid or expired." });
		}
		return res.json({ success: true, ...paired });
	} catch (err) {
		return fail(res, err, "Pairing failed");
	}
}

async function listDevices(req, res) {
	try {
		const who = await resolveActor(req);
		return res.json(await devices.listDevices(who.profileId));
	} catch (err) {
		return fail(res, err, "Failed to load devices");
	}
}

async function revokeDevice(req, res) {
	try {
		const who = await resolveActor(req);
		return res.json(await devices.revokeDevice(who.profileId, req.params.uuid));
	} catch (err) {
		return fail(res, err, "Failed to remove device");
	}
}

// ---------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------

/** POST /vision/observe — a device's structured scene (and optional keyframe). */
async function observe(req, res) {
	const who = await requireAdultActor(req, res);
	if (!who) return;
	try {
		const scene = await perception.ingestObservation(who.profileId, req.body || {}, {
			audience: who.audience,
			familyId: who.familyId,
		});
		// This frame answers something Athena asked for. Closing the request
		// here rather than in its own call means a look is only ever marked
		// answered by a frame that actually arrived.
		const requestUuid = req.body?.look_request_id;
		let answered = false;
		if (typeof requestUuid === "string" && requestUuid) {
			answered = await lookRequests.fulfil(who.profileId, requestUuid).catch(() => false);
		}
		return res.json({ success: true, scene, answered });
	} catch (err) {
		return fail(res, err, "Failed to process observation");
	}
}

/** GET /vision/look-requests — what Athena has asked to see, if anything. */
async function listLookRequests(req, res) {
	const who = await requireAdultActor(req, res);
	if (!who) return;
	try {
		return res.json({ success: true, requests: await lookRequests.pendingFor(who.profileId) });
	} catch (err) {
		return fail(res, err, "Failed to read look requests");
	}
}

/**
 * POST /vision/look-requests/:uuid/decline — the device will not look.
 *
 * Recorded rather than ignored: "she asked and the device refused" and "she
 * never asked" must not look the same afterwards, least of all to the person
 * reading back what her camera access was used for.
 */
async function declineLookRequest(req, res) {
	const who = await requireAdultActor(req, res);
	if (!who) return;
	try {
		const declined = await lookRequests.decline(
			who.profileId,
			req.params.uuid,
			typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : null
		);
		return res.json({ success: true, declined });
	} catch (err) {
		return fail(res, err, "Failed to decline look request");
	}
}

/** POST /vision/describe — one image -> strict scene JSON, nothing stored. */
async function describeScene(req, res) {
	const who = await requireAdultActor(req, res);
	if (!who) return;
	try {
		const body = req.body || {};
		if (typeof body.imageBase64 !== "string" || body.imageBase64.length < 100) {
			return res.status(400).json({ success: false, message: "An image is required" });
		}
		const scene = await perception.structureScene({
			imageBase64: body.imageBase64,
			mimeType: body.mimeType || "image/jpeg",
			detections: body.detections,
			source: body.source || {},
			audience: who.audience,
		});
		return res.json({ success: true, scene });
	} catch (err) {
		return fail(res, err, "Athena couldn't make sense of that image");
	}
}

module.exports = {
	listLookRequests,
	declineLookRequest,
	recall,
	listEvents,
	createEvent,
	deleteEvent,
	rememberPhoto,
	journal,
	llmStatus,
	llmManifest,
	deviceReport,
	registerPushToken,
	forgetPushToken,
	createPairingCode,
	redeemPairingCode,
	listDevices,
	revokeDevice,
	observe,
	describeScene,
};
