/**
 * Sightings: who and what the household cameras saw (migration 0083).
 *
 * The owner, 2026-10-18: log anything alive, or a car, when a camera sees
 * motion — by name where it can ("Wynter", "Red van"), "stranger" where it
 * can't — so "when did you last see Wynter?" has an answer, and so a rule
 * like "Wynter outside the back fence" can reach the owner's phone.
 *
 * The bridge posts each motion / doorbell / person event with one frame
 * (controllers/eufyEvents.js). The frame goes to the private bucket, the
 * vision model compares it with the gallery's reference photos, and each
 * subject it reports becomes a row. The model only perceives; whether anyone
 * is told is decided here, deterministically, by the person's own rules, and
 * the telling goes through initiative (trigger sighting_alert) with its
 * opt-in, mutes, dedupe and quiet-hours hold intact.
 *
 * What is kept: rows and frames for 30 days (owner's choice), then purged
 * nightly. A frame in which nothing was seen is deleted straight away.
 * Removing a subject deletes its sightings. Strangers stay "stranger": a
 * face that is not in the gallery is never matched against anything else —
 * only the owner naming a row ("This is…", teachFromSighting) changes one.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../helpers/db");
const llm = require("./llm");
const securityMedia = require("./securityMedia");

const BUCKET = () => process.env.SECURITY_MEDIA_BUCKET || "athena-security-media";
const KINDS = ["person", "animal", "vehicle"];
const RETENTION_DAYS = 30;
const MAX_PHOTOS_PER_SUBJECT = 3;
const MAX_SUBJECTS_IN_PROMPT = 24;
const MAX_PER_FRAME = 12;
/** Sightings of one subject closer together than this are one occurrence (one alert). */
const OCCURRENCE_GAP_MS = 30 * 60_000;

let storageClient = null;
function storage() {
	if (!storageClient) {
		const { Storage } = require("@google-cloud/storage");
		storageClient = new Storage({ projectId: process.env.GCP_PROJECT_ID || undefined });
	}
	return storageClient;
}

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

async function listSubjects() {
	const [subjects] = await pool.query("SELECT * FROM athena_sighting_subject ORDER BY kind, name");
	const [photos] = await pool.query("SELECT subject_id, media_uuid FROM athena_sighting_subject_photo ORDER BY added_at");
	const [last] = await pool.query(
		`SELECT s.subject_id, s.seen_at, s.device_name, s.where_text FROM athena_sighting s
		 JOIN (SELECT subject_id, MAX(seen_at) m FROM athena_sighting WHERE subject_id IS NOT NULL GROUP BY subject_id) l
		   ON l.subject_id = s.subject_id AND l.m = s.seen_at`,
	);
	const lastBy = new Map(last.map((r) => [Number(r.subject_id), r]));
	return subjects.map((s) => {
		const l = lastBy.get(Number(s.id));
		return {
			id: s.uuid,
			name: s.name,
			kind: s.kind,
			description: s.description,
			photos: photos.filter((p) => Number(p.subject_id) === Number(s.id)).map((p) => p.media_uuid),
			lastSeen: l ? { at: new Date(l.seen_at).toISOString(), camera: l.device_name, where: l.where_text } : null,
		};
	});
}

async function subjectRow(uuid) {
	const [rows] = await pool.query("SELECT * FROM athena_sighting_subject WHERE uuid = ?", [uuid]);
	if (!rows[0]) throw bad("That name isn't in the gallery.", 404);
	return rows[0];
}

function cleanSubject(body, partial = false) {
	const out = {};
	if (!partial || body.name !== undefined) {
		const name = clip(body.name, 60);
		if (!name) throw bad("Give them a name.");
		if (/^(stranger|unknown)/i.test(name)) throw bad("That name is reserved for people Athena doesn't know.");
		out.name = name;
	}
	if (!partial || body.kind !== undefined) {
		if (!KINDS.includes(body.kind)) throw bad("Kind must be person, animal or vehicle.");
		out.kind = body.kind;
	}
	if (body.description !== undefined) out.description = clip(body.description, 300);
	return out;
}

async function createSubject(profileId, body) {
	const fields = cleanSubject(body);
	const uuid = randomUUID();
	try {
		await pool.query("INSERT INTO athena_sighting_subject SET ?", [{ uuid, ...fields, created_by: profileId, created_at: new Date() }]);
	} catch (err) {
		if (err.code === "ER_DUP_ENTRY") throw bad("That name is already in the gallery.", 409);
		throw err;
	}
	return uuid;
}

async function updateSubject(uuid, body) {
	const row = await subjectRow(uuid);
	const fields = cleanSubject(body, true);
	if (Object.keys(fields).length) await pool.query("UPDATE athena_sighting_subject SET ? WHERE id = ?", [fields, row.id]);
}

/** Removing someone removes every trace of them in the log, and the rules about them. */
async function removeSubject(uuid) {
	const row = await subjectRow(uuid);
	await pool.query("DELETE FROM athena_sighting WHERE subject_id = ?", [row.id]);
	await pool.query("DELETE FROM athena_sighting_rule WHERE subject_id = ?", [row.id]);
	await pool.query("DELETE FROM athena_sighting_subject_photo WHERE subject_id = ?", [row.id]);
	await pool.query("DELETE FROM athena_sighting_subject WHERE id = ?", [row.id]);
	photoCache.clear();
}

/** A reference photo is a kept security image; adding it stars it so it isn't deleted by accident. */
async function addPhoto(uuid, mediaUuid) {
	const row = await subjectRow(uuid);
	const media = await securityMedia.open(mediaUuid);
	if (!media || media.row.type !== "image") throw bad("Pick a kept image.", 404);
	const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM athena_sighting_subject_photo WHERE subject_id = ?", [row.id]);
	if (Number(n) >= MAX_PHOTOS_PER_SUBJECT) throw bad(`Up to ${MAX_PHOTOS_PER_SUBJECT} reference photos each.`, 409);
	await pool.query("INSERT IGNORE INTO athena_sighting_subject_photo (subject_id, media_uuid, added_at) VALUES (?, ?, ?)", [row.id, mediaUuid, new Date()]);
	if (!media.row.important) await securityMedia.setImportant(mediaUuid, true);
}

async function removePhoto(uuid, mediaUuid) {
	const row = await subjectRow(uuid);
	await pool.query("DELETE FROM athena_sighting_subject_photo WHERE subject_id = ? AND media_uuid = ?", [row.id, mediaUuid]);
	photoCache.delete(mediaUuid);
}

// ---------------------------------------------------------------------------
// Camera zones
// ---------------------------------------------------------------------------

async function listZones() {
	const [rows] = await pool.query("SELECT device_serial, name, description FROM athena_camera_zone ORDER BY device_serial, name");
	return rows.map((r) => ({ deviceSerial: r.device_serial, name: r.name, description: r.description }));
}

/** Replace one camera's zones. */
async function setZones(serial, zones) {
	if (!/^[A-Za-z0-9_-]{4,40}$/.test(serial)) throw bad("Unknown camera.");
	if (!Array.isArray(zones) || zones.length > 8) throw bad("Up to 8 zones per camera.");
	const clean = zones.map((z) => ({ name: clip(z?.name, 60), description: clip(z?.description, 200) })).filter((z) => z.name);
	if (new Set(clean.map((z) => z.name.toLowerCase())).size !== clean.length) throw bad("Zone names must differ.");
	await pool.query("DELETE FROM athena_camera_zone WHERE device_serial = ?", [serial]);
	for (const z of clean) await pool.query("INSERT INTO athena_camera_zone SET ?", [{ device_serial: serial, ...z }]);
}

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

const photoCache = new Map(); // media uuid -> base64, reference photos change rarely
async function photoBase64(mediaUuid) {
	if (photoCache.has(mediaUuid)) return photoCache.get(mediaUuid);
	const media = await securityMedia.open(mediaUuid);
	if (!media) return null;
	const [buf] = await media.file.download();
	const b64 = buf.toString("base64");
	if (photoCache.size > 100) photoCache.delete(photoCache.keys().next().value);
	photoCache.set(mediaUuid, b64);
	return b64;
}

const FRAME_SCHEMA = {
	type: "object",
	properties: {
		subjects: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					kind: { type: "string", enum: KINDS },
					label: { type: "string" },
					zone: { type: "string" },
					where: { type: "string" },
					confidence: { type: "number" },
				},
				required: ["kind", "label", "where", "confidence"],
			},
		},
	},
	required: ["subjects"],
};

function checkFrame(data) {
	if (!data || !Array.isArray(data.subjects)) return "subjects must be an array";
	return null;
}

/**
 * Ask the vision model who and what is in the frame. Returns the model's
 * subjects cleaned against the gallery and the camera's zones: a name the
 * gallery doesn't hold is never believed, a zone the camera doesn't have is
 * dropped, and a person who matches no one is "stranger".
 */
async function identify({ frameBase64, deviceName, gallery, zones }) {
	const known = gallery.slice(0, MAX_SUBJECTS_IN_PROMPT);
	const parts = [];
	const lines = [];
	for (const s of known) {
		const refs = [];
		for (const m of s.photos.slice(0, MAX_PHOTOS_PER_SUBJECT)) {
			const b64 = await photoBase64(m).catch(() => null);
			if (b64) refs.push(b64);
		}
		lines.push(`- "${s.name}" (${s.kind})${s.description ? `: ${s.description}` : ""}${refs.length ? ` — ${refs.length} reference photo(s) follow` : " — no photo, description only"}`);
		parts.push({ text: `Reference for "${s.name}":` }, ...refs.map((data) => ({ inlineData: { mimeType: "image/jpeg", data } })));
	}
	const prompt = `You are looking at one frame from a home security camera called "${deviceName || "camera"}".
List every living thing (people, dogs, cats, deer, birds big enough to notice) and every vehicle you can see in the LAST image.

Known subjects:
${lines.length ? lines.join("\n") : "(none yet)"}

For each subject in the frame:
- name: the known subject's exact name, ONLY when it clearly matches its reference photos or description; otherwise "".
- kind: person, animal or vehicle.
- label: the name if matched; otherwise a short generic label — "stranger" for any person who is not a known subject, else e.g. "unknown dog", "deer", "white pickup".
- zone: ${zones.length ? `exactly one of ${zones.map((z) => `"${z.name}"${z.description ? ` (${z.description})` : ""}`).join(", ")}, or "" if unsure` : `""`}.
- where: a few words on where in the scene, e.g. "by the back fence", "on the driveway".
- confidence: 0 to 1, how sure you are of the name (or of the label if unnamed).
Never guess a name from a partial view, darkness or distance — use the generic label instead. Don't describe people beyond that.
If nothing alive and no vehicle is visible, return an empty list.
Return ONLY JSON matching: ${JSON.stringify(FRAME_SCHEMA)}`;
	const { data } = await llm.generateJson({
		task: "vision",
		audience: "adult",
		schema: FRAME_SCHEMA,
		contents: [{ role: "user", parts: [{ text: prompt }, ...parts, { text: "The camera frame:" }, { inlineData: { mimeType: "image/jpeg", data: frameBase64 } }] }],
		check: checkFrame,
	});
	return cleanSubjects(data.subjects, known, zones);
}

function cleanSubjects(raw, gallery, zones) {
	const byName = new Map(gallery.map((s) => [s.name.toLowerCase(), s]));
	const zoneBy = new Map(zones.map((z) => [z.name.toLowerCase(), z.name]));
	const out = [];
	for (const s of (raw || []).slice(0, MAX_PER_FRAME)) {
		if (!s || !KINDS.includes(s.kind)) continue;
		const match = byName.get(String(s.name || "").trim().toLowerCase()) || byName.get(String(s.label || "").trim().toLowerCase());
		const subject = match && match.kind === s.kind ? match : null;
		let label = subject ? subject.name : clip(s.label, 60) || (s.kind === "person" ? "stranger" : `unknown ${s.kind}`);
		// A person the gallery doesn't hold is a stranger, whatever else the model called them.
		if (!subject && s.kind === "person") label = "stranger";
		if (!subject && byName.has(label.toLowerCase())) label = `unknown ${s.kind}`;
		const confidence = Number(s.confidence);
		out.push({
			subject,
			label,
			kind: s.kind,
			zone: zoneBy.get(String(s.zone || "").trim().toLowerCase()) || null,
			where: clip(s.where, 200),
			confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, Math.round(confidence * 100) / 100)) : null,
		});
	}
	return out;
}

/**
 * One event from the bridge. Returns the sightings written (possibly none).
 * `identifyWith` is for tests.
 */
async function record({ event, frame }, { identifyWith = identify } = {}) {
	const serial = String(event?.deviceSn || "");
	if (!/^[A-Za-z0-9_-]{4,40}$/.test(serial)) throw bad("Bad device.");
	const kind = ["motion", "doorbell", "person"].includes(event.kind) ? event.kind : null;
	if (!kind) throw bad("Bad event kind.");
	const seenAt = new Date(event.at);
	if (Number.isNaN(seenAt.getTime())) throw bad("Bad event time.");
	if (!frame) return []; // no picture, nothing to identify — the event itself stays in the bridge's list
	const buf = Buffer.from(frame, "base64");
	if (!buf.length || buf.length > 5_000_000 || buf[0] !== 0xff || buf[1] !== 0xd8) throw bad("Frame is not a JPEG.");

	const gallery = await listSubjects();
	const zones = await listZones();
	const found = await identifyWith({ frameBase64: buf.toString("base64"), deviceName: event.deviceName, gallery, zones: zones.filter((z) => z.deviceSerial === serial) });
	if (!found.length) return [];

	const name = `sightings/${seenAt.toISOString().slice(0, 10)}/${serial}/${randomUUID()}.jpg`;
	await storage().bucket(BUCKET()).file(name).save(buf, { resumable: false, contentType: "image/jpeg", metadata: { cacheControl: "private, no-store" } });
	const frameUri = `gs://${BUCKET()}/${name}`;
	const [subjectIds] = await pool.query("SELECT id, uuid FROM athena_sighting_subject");
	const idOf = new Map(subjectIds.map((r) => [r.uuid, r.id]));
	const written = [];
	for (const s of found) {
		const row = {
			uuid: randomUUID(),
			event_id: String(event.id || "").slice(0, 160) || randomUUID(),
			event_kind: kind,
			device_serial: serial,
			device_name: clip(event.deviceName, 120),
			seen_at: seenAt,
			subject_id: s.subject ? idOf.get(s.subject.id) || null : null,
			label: s.label,
			kind: s.kind,
			zone: s.zone,
			where_text: s.where,
			confidence: s.confidence,
			frame_uri: frameUri,
		};
		await pool.query("INSERT INTO athena_sighting SET ?", [row]);
		written.push(row);
	}
	return written;
}

// ---------------------------------------------------------------------------
// Reading the log
// ---------------------------------------------------------------------------

const shape = (r) => ({
	id: r.uuid,
	label: r.label,
	kind: r.kind,
	subjectId: r.subject_uuid || null,
	camera: r.device_name,
	deviceSerial: r.device_serial,
	zone: r.zone,
	where: r.where_text,
	confidence: r.confidence == null ? null : Number(r.confidence),
	eventKind: r.event_kind,
	seenAt: new Date(r.seen_at).toISOString(),
	hasFrame: !!r.frame_uri,
});

async function list({ label = null, limit = 50 } = {}) {
	const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
	const [rows] = await pool.query(
		`SELECT s.*, j.uuid AS subject_uuid FROM athena_sighting s
		 LEFT JOIN athena_sighting_subject j ON j.id = s.subject_id
		 ${label ? "WHERE s.label = ?" : ""} ORDER BY s.seen_at DESC, s.id DESC LIMIT ?`,
		label ? [label, lim] : [lim],
	);
	return rows.map(shape);
}

function frameFile(uri) {
	const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri || "");
	return m ? storage().bucket(m[1]).file(m[2]) : null;
}

async function openFrame(uuid) {
	const [rows] = await pool.query("SELECT frame_uri FROM athena_sighting WHERE uuid = ?", [uuid]);
	return frameFile(rows[0]?.frame_uri);
}

// ---------------------------------------------------------------------------
// Teaching from the log
// ---------------------------------------------------------------------------

const MAX_ALSO = 50;

/**
 * "This is Wynter": the owner names an unnamed sighting. The frame is copied
 * into a kept, starred security image and added as a reference photo (when the
 * subject has room), and that one row takes the name. `alsoIds` are other
 * unnamed rows the owner ticked one by one — nothing else is relabelled, and a
 * row from the same frame is refused, since two subjects in one frame are two
 * different subjects. Matching of future frames is still only the gallery's.
 */
async function teachFromSighting(profileId, sightingUuid, body = {}) {
	const [rows] = await pool.query("SELECT * FROM athena_sighting WHERE uuid = ?", [sightingUuid]);
	const sighting = rows[0];
	if (!sighting) throw bad("That sighting is gone.", 404);
	if (sighting.subject_id) throw bad("That sighting already has a name.", 409);

	const alsoIds = [...new Set(Array.isArray(body.alsoIds) ? body.alsoIds.map(String) : [])].filter((id) => id !== sightingUuid);
	if (alsoIds.length > MAX_ALSO) throw bad(`Up to ${MAX_ALSO} other sightings at once.`);
	let also = [];
	if (alsoIds.length) {
		[also] = await pool.query("SELECT * FROM athena_sighting WHERE uuid IN (?)", [alsoIds]);
		if (also.length !== alsoIds.length) throw bad("One of those sightings is gone.", 404);
		const frames = new Set([sighting.frame_uri]);
		for (const r of also) {
			if (r.subject_id) throw bad("One of those sightings already has a name.", 409);
			if (r.kind !== sighting.kind) throw bad("Those sightings aren't all the same kind.");
			if (r.frame_uri && frames.has(r.frame_uri)) throw bad("Two sightings from the same frame can't be the same one.");
			if (r.frame_uri) frames.add(r.frame_uri);
		}
	}

	let subject;
	let created = false;
	if (body.subjectId) {
		subject = await subjectRow(String(body.subjectId));
		if (subject.kind !== sighting.kind) throw bad(`${subject.name} is in the gallery as ${subject.kind === "animal" ? "an animal" : `a ${subject.kind}`}; this sighting is ${sighting.kind === "animal" ? "an animal" : `a ${sighting.kind}`}.`);
	} else if (body.newSubject) {
		const uuid = await createSubject(profileId, { ...body.newSubject, kind: sighting.kind });
		subject = await subjectRow(uuid);
		created = true;
	} else {
		throw bad("Pick someone from the gallery, or add a new name.");
	}

	let photo = { added: false, reason: null };
	try {
		photo = await framePhoto(profileId, subject, sighting);
	} catch (err) {
		// A brand-new name with nothing behind it would only confuse the gallery.
		if (created) await removeSubject(subject.uuid).catch(() => {});
		throw err;
	}

	const ids = [sighting.id, ...also.map((r) => r.id)];
	await pool.query("UPDATE athena_sighting SET subject_id = ?, label = ? WHERE id IN (?) AND subject_id IS NULL", [subject.id, subject.name, ids]);
	return { subjectId: subject.uuid, name: subject.name, created, photoAdded: photo.added, photoNote: photo.reason, renamed: ids.length };
}

/** Copy the sighting's frame into a kept image and add it as a reference photo, unless the subject is full. */
async function framePhoto(profileId, subject, sighting) {
	const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM athena_sighting_subject_photo WHERE subject_id = ?", [subject.id]);
	if (Number(n) >= MAX_PHOTOS_PER_SUBJECT) {
		return { added: false, reason: `${subject.name} already has ${MAX_PHOTOS_PER_SUBJECT} reference photos — remove one in the Gallery to use this frame.` };
	}
	const file = frameFile(sighting.frame_uri);
	if (!file) return { added: false, reason: "That sighting has no frame to learn from." };
	const [buf] = await file.download();
	const media = await securityMedia.save({ profileId, serial: sighting.device_serial, deviceName: sighting.device_name, type: "image", buf });
	try {
		await addPhoto(subject.uuid, media.id);
	} catch (err) {
		await securityMedia.remove(media.id).catch(() => {});
		if (err.status === 409) return { added: false, reason: `${subject.name} already has ${MAX_PHOTOS_PER_SUBJECT} reference photos — remove one in the Gallery to use this frame.` };
		throw err;
	}
	return { added: true, reason: null };
}

function localTime(date, timeZone) {
	const opts = { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) };
	const day = { weekday: "short", month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) };
	try {
		return `${new Intl.DateTimeFormat("en-US", day).format(date)} ${new Intl.DateTimeFormat("en-US", opts).format(date)}`;
	} catch {
		return date.toISOString();
	}
}

/**
 * The chat block for "when did you last see Wynter?" — the last sightings of
 * the named subject (or of everyone, when no name is given), as plain facts.
 */
async function chatBlock(query, { timeZone } = {}) {
	const q = String(query || "").trim().slice(0, 60);
	const gallery = await listSubjects();
	const subject = q ? gallery.find((s) => s.name.toLowerCase() === q.toLowerCase()) || gallery.find((s) => q.toLowerCase().includes(s.name.toLowerCase())) : null;
	const label = subject ? subject.name : /stranger/i.test(q) ? "stranger" : null;
	const rows = await list({ label, limit: label ? 8 : 20 });
	const names = gallery.map((s) => `${s.name} (${s.kind})`).join(", ") || "nobody yet";
	const head = [`# Home camera sightings (last ${RETENTION_DAYS} days kept)`, `Known to the cameras: ${names}.`];
	if (q && !label) head.push(`"${q}" is not in the camera gallery, so the cameras can't recognise them by name.`);
	if (!rows.length) return [...head, label ? `No sightings of ${label} in the log.` : "No sightings logged yet."].join("\n");
	return [
		...head,
		label ? `Most recent sightings of ${label}, newest first:` : "Most recent sightings, newest first:",
		...rows.map((r) => `- ${localTime(new Date(r.seenAt), timeZone)} — ${r.label}${r.camera ? ` on the ${r.camera} camera` : ""}${r.where ? `, ${r.where}` : ""}${r.zone ? ` (${r.zone})` : ""}${r.confidence != null && r.confidence < 0.6 ? " (not sure)" : ""}`),
		"These are camera sightings with the model's best identification — say so if one is marked not sure.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Rules and alerts
// ---------------------------------------------------------------------------

async function listRules(profileId) {
	const [rows] = await pool.query(
		`SELECT r.*, s.uuid AS subject_uuid, s.name AS subject_name FROM athena_sighting_rule r
		 LEFT JOIN athena_sighting_subject s ON s.id = r.subject_id WHERE r.profile_id = ? ORDER BY r.created_at`,
		[profileId],
	);
	return rows.map((r) => ({ id: r.uuid, subjectId: r.subject_uuid, subjectName: r.subject_name, label: r.label, deviceSerial: r.device_serial, zone: r.zone, enabled: !!r.enabled }));
}

async function createRule(profileId, body) {
	let subjectId = null;
	let label = null;
	if (body.subjectId) subjectId = (await subjectRow(body.subjectId)).id;
	else if (body.label === "stranger") label = "stranger";
	else throw bad("Pick someone from the gallery, or strangers.");
	const serial = body.deviceSerial ? String(body.deviceSerial) : null;
	if (serial && !/^[A-Za-z0-9_-]{4,40}$/.test(serial)) throw bad("Unknown camera.");
	const uuid = randomUUID();
	await pool.query("INSERT INTO athena_sighting_rule SET ?", [{ uuid, profile_id: profileId, subject_id: subjectId, label, device_serial: serial, zone: clip(body.zone, 60), enabled: 1, created_at: new Date() }]);
	return uuid;
}

async function removeRule(profileId, uuid) {
	const [r] = await pool.query("DELETE FROM athena_sighting_rule WHERE uuid = ? AND profile_id = ?", [uuid, profileId]);
	if (!r.affectedRows) throw bad("That alert isn't yours or is gone.", 404);
}

const matches = (rule, s) =>
	(rule.subject_id ? Number(s.subject_id) === Number(rule.subject_id) : s.label === rule.label) &&
	(!rule.device_serial || s.device_serial === rule.device_serial) &&
	(!rule.zone || (s.zone || "").toLowerCase() === rule.zone.toLowerCase());

/** Profiles whose enabled rules match any of these new sightings. */
async function profilesToAlert(rows) {
	if (!rows.length) return [];
	const [rules] = await pool.query("SELECT * FROM athena_sighting_rule WHERE enabled = 1");
	return [...new Set(rules.filter((r) => rows.some((s) => matches(r, s))).map((r) => Number(r.profile_id)))];
}

/**
 * What the sighting_alert trigger says for one person right now: every rule
 * with a match in the last OCCURRENCE_GAP_MS, each as one occurrence keyed by
 * where its run of sightings began — so a dog wandering past three times in
 * ten minutes is one alert, and the same dog out again after an hour is a new one.
 */
async function activeAlerts(profileId, { now = new Date() } = {}) {
	const [rules] = await pool.query("SELECT * FROM athena_sighting_rule WHERE profile_id = ? AND enabled = 1", [profileId]);
	if (!rules.length) return [];
	const since = new Date(now.getTime() - 6 * 60 * 60_000);
	const [rows] = await pool.query("SELECT * FROM athena_sighting WHERE seen_at >= ? ORDER BY seen_at DESC", [since]);
	const out = [];
	for (const rule of rules) {
		const hits = rows.filter((s) => matches(rule, s));
		if (!hits.length || now - new Date(hits[0].seen_at) > OCCURRENCE_GAP_MS) continue;
		let start = hits[0];
		for (const h of hits.slice(1)) {
			if (new Date(start.seen_at) - new Date(h.seen_at) > OCCURRENCE_GAP_MS) break;
			start = h;
		}
		out.push({ rule: rule.uuid, occurrence: start.uuid, latest: hits[0] });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Nightly: rows and frames older than RETENTION_DAYS. */
async function prune(days = RETENTION_DAYS) {
	const cutoff = new Date(Date.now() - days * 86_400_000);
	const [frames] = await pool.query("SELECT DISTINCT frame_uri FROM athena_sighting WHERE seen_at < ? AND frame_uri IS NOT NULL", [cutoff]);
	let deleted = 0;
	for (const { frame_uri: uri } of frames) {
		const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
		if (!m) continue;
		await storage().bucket(m[1]).file(m[2]).delete({ ignoreNotFound: true });
		deleted += 1;
	}
	const [r] = await pool.query("DELETE FROM athena_sighting WHERE seen_at < ?", [cutoff]);
	return { rows: r.affectedRows || 0, frames: deleted };
}

module.exports = {
	listSubjects, createSubject, updateSubject, removeSubject, addPhoto, removePhoto,
	listZones, setZones,
	identify, cleanSubjects, record, list, openFrame, chatBlock, teachFromSighting,
	listRules, createRule, removeRule, profilesToAlert, activeAlerts, matches,
	prune, RETENTION_DAYS, KINDS,
	_setStorage: (s) => (storageClient = s),
};
