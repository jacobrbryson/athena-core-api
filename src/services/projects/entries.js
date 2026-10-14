/**
 * A project's journal: notes, decisions, measurements and photos.
 *
 * The children rule (owner, 2026-09-11, clarified 2026-10-13): photos of
 * children stay on the device. This service is where that is enforced — not
 * the app. A project marked `involves_children`, or an entry marked so, is
 * refused image bytes outright; it can only carry a caption and the opaque
 * `device_ref` of a picture held in that device's own storage. Nothing here
 * ever decides from the picture itself that no child is in it.
 *
 * Adult photos go to a private bucket (default `athena-project-media`, no
 * lifecycle rule — progress photos are kept for years) and are only ever
 * served back through the API to the person who owns the project.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");
const { bad, read } = require("./shape");

const BUCKET = () => process.env.PROJECT_MEDIA_BUCKET || "athena-project-media";
const TYPES = ["note", "photo", "decision", "measurement"];
const PHASES = ["concept", "before", "progress", "after", "memory"];
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_ENTRIES = 2000;

let storageClient = null;
function storage() {
	if (!storageClient) {
		const { Storage } = require("@google-cloud/storage");
		storageClient = new Storage({ projectId: process.env.GCP_PROJECT_ID || undefined });
	}
	return storageClient;
}

const notFound = (what) => Object.assign(new Error(`That ${what} is not on your list.`), { status: 404 });

/** Decode a base64 image (data URL or bare) and check it really is one. */
function decodeImage(value) {
	const m = /^(?:data:(image\/(?:jpeg|png|webp));base64,)?([A-Za-z0-9+/=\s]+)$/.exec(String(value || ""));
	if (!m) throw bad("That photo isn't an image I can read.");
	const buf = Buffer.from(m[2], "base64");
	if (!buf.length) throw bad("That photo is empty.");
	if (buf.length > MAX_BYTES) throw bad("That photo is too large — 3 MB at most.");
	const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
	const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	const isWebp = buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
	if (!isJpeg && !isPng && !isWebp) throw bad("Only JPEG, PNG or WebP photos.");
	return { buf, mime: isJpeg ? "image/jpeg" : isPng ? "image/png" : "image/webp", ext: isJpeg ? "jpg" : isPng ? "png" : "webp" };
}

function toEntry(row) {
	return {
		uuid: row.uuid,
		type: row.type,
		phase: row.phase || null,
		body: row.body || null,
		media: row.media_location || null,
		deviceRef: row.device_ref || null,
		involvesChildren: !!row.involves_children,
		source: row.source,
		takenAt: row.taken_at || null,
		createdAt: row.created_at,
	};
}

async function projectRow(profileId, uuid, db = pool) {
	const [rows] = await db.query(
		"SELECT id, uuid, involves_children FROM athena_project WHERE profile_id = ? AND uuid = ? LIMIT 1",
		[profileId, String(uuid || "")]
	);
	return rows[0] || null;
}

async function list(profileId, projectUuid) {
	const project = await projectRow(profileId, projectUuid);
	if (!project) throw notFound("project");
	const [rows] = await pool.query(
		"SELECT * FROM athena_project_entry WHERE project_id = ? ORDER BY COALESCE(taken_at, created_at) DESC, id DESC LIMIT 500",
		[project.id]
	);
	return rows.map(toEntry);
}

/**
 * Add an entry. `image` (base64) is accepted only for a photo on a project
 * that does not involve children; `deviceRef` is how a child's photo is held.
 */
async function add(profileId, projectUuid, input = {}, { source = "manual", db = pool } = {}) {
	const project = await projectRow(profileId, projectUuid, db);
	if (!project) throw notFound("project");
	const type = read.pick(input.type, TYPES, "note", "Entry type");
	const phase = type === "photo" ? read.pick(input.phase ?? undefined, PHASES, "progress", "Phase") : null;
	const body = read.text(input.body, 8000, null);
	const takenAt = read.date(input.takenAt, null, "Taken on");
	const children = !!project.involves_children || !!input.involvesChildren;
	if (type !== "photo" && !body) throw bad("A note needs some text.");
	if (type !== "photo" && (input.image || input.deviceRef)) throw bad("Only a photo entry carries a picture.");

	let location = null, uri = null, deviceRef = null, upload = null;
	if (type === "photo") {
		if (input.image) {
			if (children) throw bad("Photos of children stay on your device — this project involves children, so I can't store the picture.");
			upload = decodeImage(input.image);
			location = "server";
		} else if (input.deviceRef) {
			deviceRef = read.text(input.deviceRef, 64, null);
			if (!deviceRef || !/^[\w-]+$/.test(deviceRef)) throw bad("That device photo reference isn't valid.");
			location = "device";
		} else throw bad("A photo entry needs a picture.");
	}
	const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM athena_project_entry WHERE project_id = ?", [project.id]);
	if (n >= MAX_ENTRIES) throw bad(`A project can hold at most ${MAX_ENTRIES} entries.`);

	const uuid = randomUUID();
	if (upload) {
		const name = `projects/${project.uuid}/${uuid}.${upload.ext}`;
		await storage().bucket(BUCKET()).file(name).save(upload.buf, {
			resumable: false,
			contentType: upload.mime,
			metadata: { cacheControl: "private, max-age=86400" },
		});
		uri = `gs://${BUCKET()}/${name}`;
	}
	await db.query(
		`INSERT INTO athena_project_entry (uuid, project_id, type, phase, body, media_location, media_uri, device_ref, involves_children, source, taken_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		[uuid, project.id, type, phase, body, location, uri, deviceRef, children ? 1 : 0, String(source).slice(0, 16), takenAt]
	);
	await db.query("UPDATE athena_project SET last_progress_at = NOW() WHERE id = ?", [project.id]);
	return { uuid };
}

async function entryRow(profileId, projectUuid, entryUuid) {
	const [rows] = await pool.query(
		`SELECT e.*, p.id AS pid FROM athena_project_entry e JOIN athena_project p ON p.id = e.project_id
		 WHERE p.profile_id = ? AND p.uuid = ? AND e.uuid = ? LIMIT 1`,
		[profileId, String(projectUuid || ""), String(entryUuid || "")]
	);
	return rows[0] || null;
}

/** Edit the caption, phase or date, or move the entry to another of their projects. */
async function update(profileId, projectUuid, entryUuid, patch = {}) {
	const row = await entryRow(profileId, projectUuid, entryUuid);
	if (!row) throw notFound("entry");
	const body = read.text(patch.body, 8000, row.body ?? null);
	const phase = row.type === "photo" ? read.pick(patch.phase, PHASES, row.phase || "progress", "Phase") : null;
	const takenAt = read.date(patch.takenAt, row.taken_at ? new Date(row.taken_at).toISOString().slice(0, 10) : null, "Taken on");
	if (row.type !== "photo" && !body) throw bad("A note needs some text.");
	let projectId = row.project_id;
	if (patch.moveTo !== undefined) {
		const target = await projectRow(profileId, patch.moveTo);
		if (!target) throw notFound("project");
		// A server-stored photo can't move into a project that involves children.
		if (target.involves_children && row.media_location === "server") throw bad("That project involves children, so a stored photo can't move into it.");
		projectId = target.id;
	}
	await pool.query("UPDATE athena_project_entry SET body = ?, phase = ?, taken_at = ?, project_id = ? WHERE id = ?", [body, phase, takenAt, projectId, row.id]);
	return { uuid: entryUuid };
}

async function remove(profileId, projectUuid, entryUuid) {
	const row = await entryRow(profileId, projectUuid, entryUuid);
	if (!row) throw notFound("entry");
	await pool.query("DELETE FROM athena_project_entry WHERE id = ?", [row.id]);
	if (row.media_uri) await deleteObject(row.media_uri).catch((err) => console.warn("[projects] photo delete failed:", err.message));
	return true;
}

function parseUri(uri) {
	const m = /^gs:\/\/([^/]+)\/(projects\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp))$/i.exec(String(uri || ""));
	if (!m) throw Object.assign(new Error("not a project photo path"), { status: 404 });
	return { bucket: m[1], name: m[2], contentType: m[3] === "jpg" ? "image/jpeg" : `image/${m[3]}` };
}

async function deleteObject(uri) {
	const { bucket, name } = parseUri(uri);
	await storage().bucket(bucket).file(name).delete({ ignoreNotFound: true });
}

/** The stored photo for an entry the caller owns: { file, contentType }, or throws 404. */
async function openImage(profileId, projectUuid, entryUuid) {
	const row = await entryRow(profileId, projectUuid, entryUuid);
	if (!row || row.media_location !== "server" || !row.media_uri) throw notFound("photo");
	const { bucket, name, contentType } = parseUri(row.media_uri);
	return { file: storage().bucket(bucket).file(name), contentType };
}

/** Per-project counts and the newest stored photo, for the list view. */
async function summaries(projectIds, db = pool) {
	if (!projectIds.length) return new Map();
	const [rows] = await db.query(
		`SELECT project_id, COUNT(*) AS n, SUM(type = 'photo') AS photos,
		        SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN media_location = 'server' THEN uuid END ORDER BY COALESCE(taken_at, created_at) DESC, id DESC), ',', 1) AS cover
		 FROM athena_project_entry WHERE project_id IN (?) GROUP BY project_id`,
		[projectIds]
	);
	return new Map(rows.map((r) => [r.project_id, { entries: Number(r.n), photos: Number(r.photos || 0), cover: r.cover || null }]));
}

module.exports = { list, add, update, remove, openImage, summaries, decodeImage, TYPES, PHASES, _setStorage: (s) => (storageClient = s) };
