const config = require("../../config");

/**
 * App-level secret resolution.
 *
 * "App-level" means one value for all of Athena — API keys, client secrets,
 * the encryption keyring. NOT per-user credentials: OAuth access/refresh
 * tokens belong in MySQL, encrypted with the keyring this module serves
 * (see helpers/crypto.js and docs/architecture/secret-rotation.md).
 *
 * Resolution order for every name:
 *   1. process.env[NAME] — local .env, and Cloud Run's `--update-secrets`
 *      injection. Deploy-time wiring keeps working untouched.
 *   2. Google Secret Manager `projects/<project>/secrets/<NAME>/versions/latest`
 *      via Application Default Credentials (the Cloud Run runtime SA; no key
 *      material in the image).
 *
 * Reading at runtime rather than only at deploy time is what makes rotation
 * automatic: a new secret version is picked up when the cache entry expires,
 * with no redeploy. Callers that must not wait for a TTL (the keyring on an
 * unknown key id) can pass `forceRefresh`.
 *
 * Misses are cached too, briefly, so an unconfigured optional secret does not
 * turn into a Secret Manager call on every request.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MISS_TTL_MS = 60 * 1000; // 1 minute

/** name -> { value: string|null, expiresAt: number } */
const cache = new Map();
/** name -> Promise, so N concurrent misses make ONE Secret Manager call. */
const inflight = new Map();

let clientPromise = null;
let warnedNoProject = false;

function ttl() {
	const raw = Number(config.SECRET_CACHE_TTL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

function projectId() {
	return (
		config.GCP_PROJECT_ID ||
		process.env.GOOGLE_CLOUD_PROJECT ||
		process.env.GCLOUD_PROJECT ||
		""
	);
}

/**
 * Lazily construct the Secret Manager client. Lazy so that local dev, tests,
 * and any deployment that resolves everything from env never loads the gRPC
 * stack or attempts credential discovery.
 */
function getClient() {
	if (!clientPromise) {
		clientPromise = (async () => {
			const {
				SecretManagerServiceClient,
			} = require("@google-cloud/secret-manager");
			return new SecretManagerServiceClient();
		})().catch((err) => {
			clientPromise = null; // let a later call retry
			throw err;
		});
	}
	return clientPromise;
}

function envValue(name) {
	const raw = process.env[name];
	return typeof raw === "string" && raw.trim() ? raw : null;
}

async function fetchFromSecretManager(name, version) {
	const project = projectId();
	if (!project) {
		if (!warnedNoProject) {
			console.warn(
				"[secrets] No GCP project configured (GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT); " +
					"resolving secrets from environment only."
			);
			warnedNoProject = true;
		}
		return null;
	}
	const client = await getClient();
	const [accessed] = await client.accessSecretVersion({
		name: `projects/${project}/secrets/${name}/versions/${version}`,
	});
	const data = accessed?.payload?.data;
	return data ? Buffer.from(data).toString("utf8") : null;
}

/**
 * Resolve an app-level secret. Returns null when it is not configured
 * anywhere — callers decide whether that is fatal.
 *
 * @param {string} name          Secret name (also the env var name).
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh]  Bypass and replace the cache entry.
 * @param {string}  [opts.version]       Secret Manager version (default "latest").
 * @returns {Promise<string|null>}
 */
async function getSecret(name, opts = {}) {
	if (typeof name !== "string" || !name.trim()) {
		throw new Error("getSecret() requires a secret name");
	}
	const { forceRefresh = false, version = "latest" } = opts;

	// Env always wins, and is never cached — process.env is already the cache,
	// and tests mutate it between cases.
	const fromEnv = envValue(name);
	if (fromEnv !== null) return fromEnv;

	if (!forceRefresh) {
		const hit = cache.get(name);
		if (hit && hit.expiresAt > Date.now()) return hit.value;
	}

	const pending = inflight.get(name);
	if (pending && !forceRefresh) return pending;

	const promise = (async () => {
		try {
			const value = await fetchFromSecretManager(name, version);
			cache.set(name, {
				value,
				expiresAt: Date.now() + (value === null ? MISS_TTL_MS : ttl()),
			});
			return value;
		} catch (err) {
			// NOT_FOUND (5) and PERMISSION_DENIED (7) are steady states worth a
			// short negative cache; anything else may be transient, so let the
			// next call retry immediately.
			const code = err?.code;
			if (code === 5 || code === 7) {
				cache.set(name, { value: null, expiresAt: Date.now() + MISS_TTL_MS });
			}
			console.warn(
				`[secrets] Could not read ${name} from Secret Manager:`,
				err?.message || err
			);
			return null;
		} finally {
			inflight.delete(name);
		}
	})();

	inflight.set(name, promise);
	return promise;
}

/** getSecret(), parsed as JSON. Returns null on miss or unparseable payload. */
async function getSecretJson(name, opts = {}) {
	const raw = await getSecret(name, opts);
	if (raw === null) return null;
	try {
		return JSON.parse(raw);
	} catch (err) {
		console.warn(`[secrets] ${name} is not valid JSON:`, err.message);
		return null;
	}
}

/** Like getSecret(), but throws when the secret is not configured. */
async function requireSecret(name, opts = {}) {
	const value = await getSecret(name, opts);
	if (value === null) {
		throw new Error(
			`Required secret ${name} is not configured (set the ${name} env var or create the Secret Manager secret).`
		);
	}
	return value;
}

/**
 * Write a new version of a secret, creating the secret if it does not exist.
 * Used only by the rotation job — the API runtime SA should hold
 * secretAccessor and nothing more. See docs/architecture/secret-rotation.md.
 */
async function addSecretVersion(name, value) {
	const project = projectId();
	if (!project) {
		throw new Error(
			"Cannot write a secret: no GCP project configured (set GCP_PROJECT_ID)."
		);
	}
	const client = await getClient();
	const parent = `projects/${project}`;
	const request = {
		parent: `${parent}/secrets/${name}`,
		payload: { data: Buffer.from(value, "utf8") },
	};

	// Add first, create only on NOT_FOUND. Done this way round, the common
	// path needs nothing but `secretmanager.versions.add`, so the rotation job
	// can run with secretVersionAdder on one secret instead of project admin.
	let created;
	try {
		[created] = await client.addSecretVersion(request);
	} catch (err) {
		if (err?.code !== 5) throw err; // 5 = NOT_FOUND
		await client.createSecret({
			parent,
			secretId: name,
			secret: { replication: { automatic: {} } },
		});
		[created] = await client.addSecretVersion(request);
	}
	cache.delete(name); // next read must not serve the superseded value
	return created?.name || null;
}

/** Drop cached values. Exposed for tests and for the rotation job. */
function clearCache(name) {
	if (name) cache.delete(name);
	else cache.clear();
}

module.exports = {
	getSecret,
	getSecretJson,
	requireSecret,
	addSecretVersion,
	clearCache,
};
