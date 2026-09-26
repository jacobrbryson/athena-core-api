/**
 * A picture of the dream — painted from her retelling of the night, stored in
 * a private GCS bucket (default `athena-dreams`), served to the app through
 * the API (GET /api/v1/dreams/:uuid/image), never by public URL.
 *
 * It is made ONLY from the narrative, which was itself made only from the
 * redacted log: no names, places or remembered values reach the image model.
 * The prompt also forbids text and recognisable people, so nothing personal
 * can come back out of the picture either.
 *
 * Retention: the bucket's lifecycle rule deletes objects after 30 days, the
 * same window as the Dreams log (deploy/scripts/setup-athena-mind.sh).
 */
const llm = require("../llm");

const BUCKET = () => process.env.ATHENA_DREAM_BUCKET || "athena-dreams";
const PREFIX = "dreams/";

let storageClient = null;
function storage() {
	if (!storageClient) {
		const { Storage } = require("@google-cloud/storage");
		storageClient = new Storage({ projectId: process.env.GCP_PROJECT_ID || undefined });
	}
	return storageClient;
}

function imagePrompt(narrative) {
	return `A dreamlike painting of this dream, told by an AI who spent the night reorganizing her memories into a library of her own design:

"${String(narrative).slice(0, 2500)}"

Style: soft, luminous, slightly surreal; deep indigo and violet night palette with warm lamplight; rooms of drawers, glowing threads, doors, tides and letters where the dream mentions them. Painterly, calm, a little uncanny, never frightening.
Strictly: no text, letters, numbers or code anywhere in the image; no recognisable people or faces — at most a small, distant silhouette.`;
}

/** The object path for a night — date first, so the bucket lists in order. */
function objectName(night, ext) {
	return `${PREFIX}${night.date}-${night.uuid}.${ext}`;
}

/**
 * Paint and store. Returns `gs://bucket/path` or throws; the caller records
 * the failure and the dream stands without a picture.
 */
async function paint(night, narrative) {
	if (!narrative) throw new Error("no narrative to paint");
	const out = await llm.image(imagePrompt(narrative), { size: "1536x1024", quality: "medium" });
	const img = out.images?.[0];
	if (!img?.b64) throw new Error(`${out.endpointId} returned no image bytes`);
	const mime = img.mimeType || img.mime || "image/png";
	const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
	const name = objectName(night, ext);
	await storage()
		.bucket(BUCKET())
		.file(name)
		.save(Buffer.from(img.b64, "base64"), {
			resumable: false,
			contentType: mime,
			metadata: { cacheControl: "private, max-age=86400", metadata: { dream: night.uuid, model: String(out.model || "") } },
		});
	return { path: `gs://${BUCKET()}/${name}`, model: out.model };
}

/** Stream a stored image. `path` is the gs:// URL recorded on the dream. */
function open(path) {
	const m = /^gs:\/\/([^/]+)\/(dreams\/[\w.-]+)$/.exec(String(path || ""));
	if (!m) throw Object.assign(new Error("not a dream image path"), { status: 404 });
	const file = storage().bucket(m[1]).file(m[2]);
	return { file, contentType: m[2].endsWith(".jpg") ? "image/jpeg" : m[2].endsWith(".webp") ? "image/webp" : "image/png" };
}

module.exports = { paint, open, imagePrompt, objectName, _setStorage: (s) => (storageClient = s) };
