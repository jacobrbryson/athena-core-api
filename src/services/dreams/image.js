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

/**
 * The medium changes nightly. One fixed style (indigo night, lamplight,
 * drawers) made every picture the same picture whatever the dream said.
 */
const MEDIA = [
	"loose watercolour with soft bleeding edges",
	"gouache, like a mid-century storybook illustration",
	"a two-colour linocut print",
	"thick impasto oil paint",
	"cut-paper collage with visible layers and shadows",
	"Japanese woodblock print",
	"ink wash with a single accent colour",
	"stained glass, lit from behind",
	"soft chalk pastel on toned paper",
	"a risograph print with slightly misregistered colours",
	"coloured pencil, delicate and grainy",
	"a 1970s paperback-cover painting, airbrushed and vivid",
];

function pickMedium(night) {
	let h = 7;
	for (const ch of `${night?.date || ""}:medium`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
	return MEDIA[h % MEDIA.length];
}

function imagePrompt(narrative, { world = null, medium = MEDIA[0] } = {}) {
	return `A dreamlike picture of this dream, told by an AI about her night${world ? ` (it took place in ${world})` : ""}:

"${String(narrative).slice(0, 2500)}"

Medium: ${medium}. Take the palette, light and setting from the dream itself, not from any house style; show its single strangest moment rather than a general scene. Slightly surreal, a little uncanny, never frightening.
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
async function paint(night, narrative, { world = null } = {}) {
	if (!narrative) throw new Error("no narrative to paint");
	const medium = pickMedium(night);
	const out = await llm.image(imagePrompt(narrative, { world, medium }), { size: "1536x1024", quality: "medium" });
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
	return { path: `gs://${BUCKET()}/${name}`, model: out.model, medium };
}

/** Stream a stored image. `path` is the gs:// URL recorded on the dream. */
function open(path) {
	const m = /^gs:\/\/([^/]+)\/(dreams\/[\w.-]+)$/.exec(String(path || ""));
	if (!m) throw Object.assign(new Error("not a dream image path"), { status: 404 });
	const file = storage().bucket(m[1]).file(m[2]);
	return { file, contentType: m[2].endsWith(".jpg") ? "image/jpeg" : m[2].endsWith(".webp") ? "image/webp" : "image/png" };
}

module.exports = { paint, open, imagePrompt, pickMedium, MEDIA, objectName, _setStorage: (s) => (storageClient = s) };
