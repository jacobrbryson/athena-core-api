const crypto = require("crypto");
const config = require("../config");
const secrets = require("../services/secrets");

/**
 * Symmetric encryption for secrets at rest (partner API tokens today,
 * per-user OAuth credentials next).
 *
 * AES-256-GCM under a VERSIONED KEYRING, so the key can be rotated on a
 * schedule without downtime and without a big-bang re-encryption:
 *
 *   {"active":"k2","keys":{"k1":"<64 hex>","k2":"<64 hex>"}}
 *
 * stored as the `ATHENA_ENC_KEYRING` secret (env var or Secret Manager).
 * `active` encrypts; every key in `keys` still decrypts, so rows written
 * under a retired key keep working until the rotation job re-encrypts them.
 *
 * Stored formats (':'-joined, base64 parts):
 *   v2:<keyId>:<iv>:<authTag>:<ciphertext>     keyring
 *   v1:<iv>:<authTag>:<ciphertext>             legacy, pre-keyring
 *
 * v1 is back-compat for rows written before the keyring existed; its key is
 * derived from INTEGRATION_ENC_KEY (or JWT_SECRET) exactly as before. When no
 * keyring is configured we keep WRITING v1 as well, so deploying this change
 * alters nothing until a keyring is actually created.
 *
 * These functions are async because the keyring is fetched (and cached) from
 * Secret Manager.
 */

const ALGO = "aes-256-gcm";
const KEYRING_SECRET = "ATHENA_ENC_KEYRING";
const KEYRING_TTL_MS = 10 * 60 * 1000;
const LEGACY_KEY_ID = "legacy";
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

let warnedFallback = false;
/** { keys: Map<string,Buffer>, activeId: string, legacy: boolean, expiresAt: number } */
let keyring = null;
let keyringInflight = null;

// ---------------------------------------------------------------------------
// Keyring loading
// ---------------------------------------------------------------------------

/** The pre-keyring key derivation. Unchanged, so existing v1 rows still open. */
function deriveLegacyKey() {
	const raw = config.INTEGRATION_ENC_KEY;
	if (raw && /^[0-9a-fA-F]{64}$/.test(raw.trim())) {
		// A proper 32-byte (64 hex char) key.
		return Buffer.from(raw.trim(), "hex");
	}
	if (raw && raw.trim()) {
		// Any other non-empty value: stretch it to 32 bytes.
		return crypto.scryptSync(raw.trim(), "athena-integration", 32);
	}
	if (!config.JWT_SECRET) {
		throw new Error(
			"Cannot encrypt secrets at rest: set ATHENA_ENC_KEYRING (recommended), INTEGRATION_ENC_KEY, or JWT_SECRET."
		);
	}
	if (!warnedFallback) {
		console.warn(
			"[crypto] No ATHENA_ENC_KEYRING or INTEGRATION_ENC_KEY; deriving the encryption key from JWT_SECRET. Set a keyring in production."
		);
		warnedFallback = true;
	}
	return crypto.scryptSync(config.JWT_SECRET, "athena-integration", 32);
}

function parseKeyring(raw) {
	if (!raw || typeof raw !== "object") return null;
	const { active, keys } = raw;
	if (typeof active !== "string" || !keys || typeof keys !== "object") {
		throw new Error(
			`${KEYRING_SECRET} must look like {"active":"<id>","keys":{"<id>":"<64 hex>"}}`
		);
	}
	const parsed = new Map();
	for (const [id, hex] of Object.entries(keys)) {
		if (!KEY_ID_RE.test(id)) {
			throw new Error(`${KEYRING_SECRET}: invalid key id ${JSON.stringify(id)}`);
		}
		if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
			throw new Error(
				`${KEYRING_SECRET}: key ${id} must be 64 hex characters (32 bytes)`
			);
		}
		parsed.set(id, Buffer.from(hex.trim(), "hex"));
	}
	if (!parsed.has(active)) {
		throw new Error(
			`${KEYRING_SECRET}: active key ${active} is not present in keys`
		);
	}
	return { keys: parsed, activeId: active, legacy: false };
}

async function loadKeyring(forceRefresh) {
	const raw = await secrets.getSecretJson(KEYRING_SECRET, { forceRefresh });
	const parsed = parseKeyring(raw);
	if (parsed) return parsed;
	// No keyring configured — synthesize a single-key one from the legacy
	// derivation so behavior is identical to the pre-keyring code.
	return {
		keys: new Map([[LEGACY_KEY_ID, deriveLegacyKey()]]),
		activeId: LEGACY_KEY_ID,
		legacy: true,
	};
}

async function getKeyring({ forceRefresh = false } = {}) {
	if (!forceRefresh && keyring && keyring.expiresAt > Date.now()) return keyring;
	if (keyringInflight && !forceRefresh) return keyringInflight;

	keyringInflight = (async () => {
		try {
			const loaded = await loadKeyring(forceRefresh);
			keyring = { ...loaded, expiresAt: Date.now() + KEYRING_TTL_MS };
			return keyring;
		} finally {
			keyringInflight = null;
		}
	})();
	return keyringInflight;
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a UTF-8 string under the active key.
 * @returns {Promise<string>} versioned, ':'-joined ciphertext
 */
async function encrypt(plaintext) {
	if (typeof plaintext !== "string" || !plaintext.length) {
		throw new Error("encrypt() requires a non-empty string");
	}
	const ring = await getKeyring();
	const key = ring.keys.get(ring.activeId);
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv(ALGO, key, iv);
	const ciphertext = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	const parts = [
		iv.toString("base64"),
		cipher.getAuthTag().toString("base64"),
		ciphertext.toString("base64"),
	];
	// Without a configured keyring, keep emitting the original v1 format.
	return ring.legacy
		? ["v1", ...parts].join(":")
		: ["v2", ring.activeId, ...parts].join(":");
}

function parsePayload(payload) {
	if (typeof payload !== "string" || !payload.length) {
		throw new Error("decrypt() requires a non-empty string");
	}
	const parts = payload.split(":");
	if (parts[0] === "v1" && parts.length === 4) {
		return { keyId: LEGACY_KEY_ID, iv: parts[1], tag: parts[2], data: parts[3] };
	}
	if (parts[0] === "v2" && parts.length === 5 && KEY_ID_RE.test(parts[1])) {
		return { keyId: parts[1], iv: parts[2], tag: parts[3], data: parts[4] };
	}
	throw new Error("Unrecognized ciphertext format");
}

function openWith(key, { iv, tag, data }) {
	const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, "base64"));
	decipher.setAuthTag(Buffer.from(tag, "base64"));
	return Buffer.concat([
		decipher.update(Buffer.from(data, "base64")),
		decipher.final(),
	]).toString("utf8");
}

/**
 * Decrypt a string produced by encrypt(). Throws if tampered, or if the key
 * that wrote it is no longer on the keyring.
 * @returns {Promise<string>}
 */
async function decrypt(payload) {
	const parsed = parsePayload(payload);
	let ring = await getKeyring();
	let key = ring.keys.get(parsed.keyId);

	// A key id we do not know usually means rotation just added one and this
	// process is holding a stale keyring. Refetch once before giving up.
	if (!key) {
		ring = await getKeyring({ forceRefresh: true });
		key = ring.keys.get(parsed.keyId);
	}
	if (!key) {
		// A v1 row while a keyring is configured: fall back to the legacy key.
		if (parsed.keyId === LEGACY_KEY_ID) key = deriveLegacyKey();
		else throw new Error(`No key ${parsed.keyId} on the keyring; cannot decrypt`);
	}
	return openWith(key, parsed);
}

// ---------------------------------------------------------------------------
// Rotation support (used by src/jobs/rotate-keys.js)
// ---------------------------------------------------------------------------

/** Key id that wrote a ciphertext, without decrypting it. Sync. */
function keyIdOf(payload) {
	try {
		return parsePayload(payload).keyId;
	} catch {
		return null;
	}
}

/** Id of the key new writes use. */
async function activeKeyId() {
	return (await getKeyring()).activeId;
}

/** True when a ciphertext was written under a key that is no longer active. */
async function needsReencrypt(payload) {
	const id = keyIdOf(payload);
	return id !== null && id !== (await activeKeyId());
}

/** Generate a fresh 32-byte key as lowercase hex. */
function generateKeyHex() {
	return crypto.randomBytes(32).toString("hex");
}

/**
 * The pre-keyring key as hex, so the rotation job can seed it onto a new
 * keyring under the id `legacy` and keep existing v1 rows readable without
 * depending on JWT_SECRET / INTEGRATION_ENC_KEY any more. Returns null when
 * no legacy key can be derived (nothing was ever encrypted with one).
 */
function legacyKeyHex() {
	try {
		return deriveLegacyKey().toString("hex");
	} catch {
		return null;
	}
}

/** Drop the cached keyring. For tests and for the rotation job. */
function resetKeyringCache() {
	keyring = null;
	keyringInflight = null;
}

module.exports = {
	encrypt,
	decrypt,
	keyIdOf,
	activeKeyId,
	needsReencrypt,
	generateKeyHex,
	legacyKeyHex,
	resetKeyringCache,
	KEYRING_SECRET,
	LEGACY_KEY_ID,
};
