const crypto = require("crypto");
const config = require("../config");

/**
 * Symmetric encryption for secrets at rest (currently partner API tokens
 * stored in `integration_link.access_token`).
 *
 * Uses AES-256-GCM (authenticated encryption). The key is derived once
 * from `INTEGRATION_ENC_KEY` when set, otherwise from `JWT_SECRET` as a
 * dev-only fallback so local setups work without an extra secret. In
 * production set a dedicated 32-byte key:
 *
 *   openssl rand -hex 32   ->  INTEGRATION_ENC_KEY
 *
 * Stored format (single string, ':'-joined, base64 parts):
 *   v1:<iv>:<authTag>:<ciphertext>
 */

const ALGO = "aes-256-gcm";
const VERSION = "v1";

let warnedFallback = false;

function deriveKey() {
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
			"Cannot encrypt integration secrets: set INTEGRATION_ENC_KEY (recommended) or JWT_SECRET."
		);
	}
	if (!warnedFallback) {
		console.warn(
			"[crypto] INTEGRATION_ENC_KEY not set; deriving integration encryption key from JWT_SECRET. Set a dedicated key in production."
		);
		warnedFallback = true;
	}
	return crypto.scryptSync(config.JWT_SECRET, "athena-integration", 32);
}

/** Encrypt a UTF-8 string. Returns the versioned, ':'-joined token string. */
function encrypt(plaintext) {
	if (typeof plaintext !== "string" || !plaintext.length) {
		throw new Error("encrypt() requires a non-empty string");
	}
	const key = deriveKey();
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv(ALGO, key, iv);
	const ciphertext = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	const authTag = cipher.getAuthTag();
	return [
		VERSION,
		iv.toString("base64"),
		authTag.toString("base64"),
		ciphertext.toString("base64"),
	].join(":");
}

/** Decrypt a string produced by encrypt(). Throws if tampered/invalid. */
function decrypt(payload) {
	if (typeof payload !== "string" || !payload.length) {
		throw new Error("decrypt() requires a non-empty string");
	}
	const parts = payload.split(":");
	if (parts.length !== 4 || parts[0] !== VERSION) {
		throw new Error("Unrecognized ciphertext format");
	}
	const [, ivB64, tagB64, dataB64] = parts;
	const key = deriveKey();
	const decipher = crypto.createDecipheriv(
		ALGO,
		key,
		Buffer.from(ivB64, "base64")
	);
	decipher.setAuthTag(Buffer.from(tagB64, "base64"));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(dataB64, "base64")),
		decipher.final(),
	]);
	return plaintext.toString("utf8");
}

module.exports = { encrypt, decrypt };
