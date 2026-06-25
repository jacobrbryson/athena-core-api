const crypto = require("crypto");

/**
 * One-way hashing for Guardian Secrets.
 *
 * Guardian Secrets are short (6 alpha-numeric chars) shared credentials, so
 * we never store them in plaintext. We use scrypt (a memory-hard KDF that
 * ships with Node, so no extra dependency) with a per-secret random salt.
 *
 * Stored format (single string, '$'-joined):
 *   scrypt$<N>$<saltB64>$<hashB64>
 *
 * Verification is constant-time (crypto.timingSafeEqual) to avoid leaking
 * information through timing. The login flow additionally uses a generic
 * error message regardless of which part of the credential was wrong.
 */

const ALGO = "scrypt";
const COST = 16384; // scrypt N (CPU/memory cost)
const KEYLEN = 32;
const SALT_BYTES = 16;

/** Hash a Guardian Secret. Returns the versioned, '$'-joined string. */
function hashSecret(plain) {
	if (typeof plain !== "string" || !plain.length) {
		throw new Error("hashSecret() requires a non-empty string");
	}
	const salt = crypto.randomBytes(SALT_BYTES);
	const derived = crypto.scryptSync(plain, salt, KEYLEN, { N: COST });
	return [
		ALGO,
		String(COST),
		salt.toString("base64"),
		derived.toString("base64"),
	].join("$");
}

/**
 * Verify a Guardian Secret against a stored hash. Returns false (never
 * throws) on any malformed input so callers can treat it as "no match".
 */
function verifySecret(plain, stored) {
	try {
		if (typeof plain !== "string" || typeof stored !== "string") return false;
		const parts = stored.split("$");
		if (parts.length !== 4 || parts[0] !== ALGO) return false;
		const cost = Number(parts[1]);
		const salt = Buffer.from(parts[2], "base64");
		const expected = Buffer.from(parts[3], "base64");
		const derived = crypto.scryptSync(plain, salt, expected.length, {
			N: cost,
		});
		return crypto.timingSafeEqual(derived, expected);
	} catch {
		return false;
	}
}

module.exports = { hashSecret, verifySecret };
