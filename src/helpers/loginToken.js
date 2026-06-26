const crypto = require("crypto");

/**
 * Single-use QR login tokens for Guardians.
 *
 * Unlike the 6-char Guardian Secret (helpers/secret.js), a login token is
 * high-entropy and machine-generated, so it does NOT need a slow salted KDF.
 * We store a deterministic SHA-256 hash so the token can be looked up by value
 * at redeem time, while the plaintext is never persisted (it lives only in the
 * QR code). 32 random bytes → 256 bits of entropy makes brute force infeasible.
 *
 * The token is base64url so it is safe to drop straight into a URL path
 * (/q/<token>) with no escaping.
 */

const TOKEN_BYTES = 32;

/** Generate a fresh, URL-safe login token (the plaintext, shown once). */
function generateToken() {
	return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Deterministic lookup hash for a token. Returns lowercase hex (64 chars). */
function hashToken(token) {
	if (typeof token !== "string" || !token.length) {
		throw new Error("hashToken() requires a non-empty string");
	}
	return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = { generateToken, hashToken, TOKEN_BYTES };
