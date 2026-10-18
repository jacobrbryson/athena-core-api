/**
 * Camera images and clips kept from Property -> Security (migration 0082).
 *
 * The bytes go to a private bucket (default `athena-security-media`, public
 * access prevented, no lifecycle rule) and are only ever served back through
 * the API to an authorized adult — the gs:// path never leaves the server.
 * A row exists only because a person asked for the image or clip; nothing
 * here captures anything on its own.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../helpers/db");

const BUCKET = () => process.env.SECURITY_MEDIA_BUCKET || "athena-security-media";
const TYPES = { image: { contentType: "image/jpeg", ext: "jpg" }, clip: { contentType: "video/mp4", ext: "mp4" } };
const LIST_LIMIT = 60;

let storageClient = null;
function storage() {
	if (!storageClient) {
		const { Storage } = require("@google-cloud/storage");
		storageClient = new Storage({ projectId: process.env.GCP_PROJECT_ID || undefined });
	}
	return storageClient;
}

const shape = (r) => ({
	id: r.uuid,
	deviceSerial: r.device_serial,
	deviceName: r.device_name,
	type: r.media_type,
	contentType: r.content_type,
	bytes: Number(r.bytes),
	durationSeconds: r.duration_s == null ? null : Number(r.duration_s),
	important: !!r.important,
	capturedBy: Number(r.captured_by),
	capturedAt: new Date(r.captured_at).toISOString(),
});

/** Date first so the bucket lists in order; serial is already validated by the caller. */
function objectName(type, serial, uuid, at) {
	return `${type}s/${at.toISOString().slice(0, 10)}/${serial}/${uuid}.${TYPES[type].ext}`;
}

async function save({ profileId, serial, deviceName, type, buf, durationSeconds = null }) {
	const spec = TYPES[type];
	if (!spec) throw new Error("unknown_media_type");
	const uuid = randomUUID();
	const at = new Date();
	const name = objectName(type, serial, uuid, at);
	await storage().bucket(BUCKET()).file(name).save(buf, {
		resumable: false,
		contentType: spec.contentType,
		metadata: { cacheControl: "private, no-store" },
	});
	const row = {
		uuid,
		captured_by: profileId,
		device_serial: serial,
		device_name: deviceName ? String(deviceName).slice(0, 120) : null,
		media_type: type,
		content_type: spec.contentType,
		bytes: buf.length,
		duration_s: durationSeconds,
		media_uri: `gs://${BUCKET()}/${name}`,
		// A clip is recorded on purpose; an image is kept but not starred.
		important: type === "clip" ? 1 : 0,
		captured_at: at,
	};
	try {
		await pool.query("INSERT INTO athena_security_media SET ?", [row]);
	} catch (err) {
		// No row means no way to find or delete the object again, so don't leave it behind.
		await storage().bucket(BUCKET()).file(name).delete({ ignoreNotFound: true }).catch(() => {});
		throw err;
	}
	return shape(row);
}

async function list({ limit = LIST_LIMIT } = {}) {
	const [rows] = await pool.query(
		"SELECT * FROM athena_security_media ORDER BY captured_at DESC, id DESC LIMIT ?",
		[Math.min(Math.max(Number(limit) || LIST_LIMIT, 1), 200)],
	);
	return rows.map(shape);
}

async function find(uuid) {
	const [rows] = await pool.query("SELECT * FROM athena_security_media WHERE uuid = ? LIMIT 1", [uuid]);
	return rows[0] || null;
}

function parseUri(uri) {
	const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri || "");
	if (!m) throw new Error("bad_media_uri");
	return { bucket: m[1], name: m[2] };
}

/** The stored object for one row, or null when the row is gone. */
async function open(uuid) {
	const row = await find(uuid);
	if (!row) return null;
	const { bucket, name } = parseUri(row.media_uri);
	return { file: storage().bucket(bucket).file(name), contentType: row.content_type, bytes: Number(row.bytes), row: shape(row) };
}

async function setImportant(uuid, important) {
	const [result] = await pool.query("UPDATE athena_security_media SET important = ? WHERE uuid = ?", [important ? 1 : 0, uuid]);
	if (!result.affectedRows) return null;
	return shape(await find(uuid));
}

/** Deletes the object first: a row whose bytes are gone is easier to notice than bytes no row points at. */
async function remove(uuid) {
	const row = await find(uuid);
	if (!row) return false;
	const { bucket, name } = parseUri(row.media_uri);
	await storage().bucket(bucket).file(name).delete({ ignoreNotFound: true });
	await pool.query("DELETE FROM athena_security_media WHERE uuid = ?", [uuid]);
	return true;
}

module.exports = { save, list, open, setImportant, remove, objectName, _setStorage: (s) => (storageClient = s) };
