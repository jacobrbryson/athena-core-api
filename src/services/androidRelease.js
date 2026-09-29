/**
 * The Android app, downloadable from the Companion site by someone signed in.
 *
 * The APK (~130 MB) lives in a private GCS bucket beside a small manifest,
 * `android/latest.json`, written by native-runtime/Tools/publish-android.mjs.
 * It is never public and never streamed through the API: Cloud Run caps a
 * response at 32 MiB, so the API mints a short-lived V4 signed URL and the
 * phone downloads straight from Cloud Storage. The link is the only thing a
 * second phone needs, which is what makes the QR code in "Phone & car" work
 * without signing in on that phone — and why it expires in minutes.
 *
 * Installing the app grants nothing: the phone still pairs with a code or
 * signs in before it can reach anyone's data.
 */
const BUCKET = () => process.env.ATHENA_ANDROID_BUCKET || "athena-android-releases";
const MANIFEST = "android/latest.json";
const LINK_TTL_MS = 15 * 60 * 1000;
const MANIFEST_TTL_MS = 60 * 1000;
const OBJECT_RE = /^android\/Athena-[\w.-]+\.apk$/;

let storageClient = null;
function storage() {
	if (!storageClient) {
		const { Storage } = require("@google-cloud/storage");
		storageClient = new Storage({ projectId: process.env.GCP_PROJECT_ID || undefined });
	}
	return storageClient;
}

let cached = null; // { at, release }

/** A manifest is trusted only as far as its shape: the object path is pinned. */
function parseManifest(raw) {
	const m = typeof raw === "string" ? JSON.parse(raw) : raw;
	if (!m || !Number.isInteger(m.versionCode) || m.versionCode < 1) throw new Error("manifest has no versionCode");
	if (!OBJECT_RE.test(String(m.object || ""))) throw new Error("manifest object path is invalid");
	if (!/^[a-f0-9]{64}$/.test(String(m.sha256 || ""))) throw new Error("manifest sha256 is invalid");
	return {
		versionCode: m.versionCode,
		versionName: String(m.versionName || m.versionCode).slice(0, 40),
		object: m.object,
		sha256: m.sha256,
		size: Number(m.size) || null,
		builtAt: m.builtAt || null,
		notes: m.notes ? String(m.notes).slice(0, 500) : null,
	};
}

/** The published release, or null when nothing has been published yet. */
async function latest({ fresh = false } = {}) {
	if (!fresh && cached && Date.now() - cached.at < MANIFEST_TTL_MS) return cached.release;
	let release = null;
	try {
		const [buf] = await storage().bucket(BUCKET()).file(MANIFEST).download();
		release = parseManifest(buf.toString("utf8"));
	} catch (err) {
		if (err.code !== 404) throw err;
	}
	cached = { at: Date.now(), release };
	return release;
}

/** What the app shows: everything but the storage path. */
function describe(release) {
	if (!release) return { available: false };
	const { object, ...shown } = release;
	return { available: true, ...shown };
}

/** A download link that works for LINK_TTL_MS, for whoever holds it. */
async function downloadLink(now = Date.now()) {
	const release = await latest();
	if (!release) throw Object.assign(new Error("No Android release has been published yet"), { status: 404 });
	const expires = now + LINK_TTL_MS;
	const filename = `Athena-${release.versionName.replace(/[^\w.-]/g, "_")}.apk`;
	const [url] = await storage()
		.bucket(BUCKET())
		.file(release.object)
		.getSignedUrl({
			version: "v4",
			action: "read",
			expires,
			responseDisposition: `attachment; filename="${filename}"`,
			responseType: "application/vnd.android.package-archive",
		});
	return { url, expiresAt: new Date(expires).toISOString(), versionCode: release.versionCode, versionName: release.versionName };
}

module.exports = {
	latest,
	describe,
	downloadLink,
	parseManifest,
	LINK_TTL_MS,
	_setStorage: (s) => {
		storageClient = s;
		cached = null;
	},
};
