/**
 * Keyring encryption: round-trips, rotation survivability, and the
 * back-compat guarantees that let this ship without a data migration.
 */
process.env.JWT_SECRET = "test-jwt-secret";
delete process.env.INTEGRATION_ENC_KEY;
delete process.env.ATHENA_ENC_KEYRING;

const mockGetSecretJson = jest.fn();
jest.mock("../services/secrets", () => ({ getSecretJson: mockGetSecretJson }));

const {
	encrypt,
	decrypt,
	keyIdOf,
	activeKeyId,
	needsReencrypt,
	generateKeyHex,
	legacyKeyHex,
	resetKeyringCache,
} = require("./crypto");

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

/** Point the keyring secret at `ring` (null = not configured) and drop caches. */
function useKeyring(ring) {
	mockGetSecretJson.mockReset();
	mockGetSecretJson.mockResolvedValue(ring);
	resetKeyringCache();
}

beforeEach(() => {
	jest.restoreAllMocks();
	// The legacy-fallback path warns by design; keep it out of test output.
	jest.spyOn(console, "warn").mockImplementation(() => {});
	useKeyring(null);
});

afterEach(() => jest.restoreAllMocks());

describe("with a keyring configured", () => {
	beforeEach(() => useKeyring({ active: "k2", keys: { k1: KEY_A, k2: KEY_B } }));

	it("encrypts under the active key and round-trips", async () => {
		const payload = await encrypt("strava-refresh-token");
		expect(payload.startsWith("v2:k2:")).toBe(true);
		expect(await decrypt(payload)).toBe("strava-refresh-token");
	});

	it("reports the active key id", async () => {
		expect(await activeKeyId()).toBe("k2");
	});

	it("still decrypts ciphertext written under a retired key", async () => {
		useKeyring({ active: "k1", keys: { k1: KEY_A } });
		const old = await encrypt("written-before-rotation");
		expect(keyIdOf(old)).toBe("k1");

		// Rotation adds k2 and keeps k1 for reading.
		useKeyring({ active: "k2", keys: { k1: KEY_A, k2: KEY_B } });
		expect(await decrypt(old)).toBe("written-before-rotation");
		expect(await needsReencrypt(old)).toBe(true);
	});

	it("rejects tampered ciphertext", async () => {
		const payload = await encrypt("do-not-modify");
		const parts = payload.split(":");
		const body = Buffer.from(parts[4], "base64");
		body[0] ^= 0xff;
		parts[4] = body.toString("base64");
		await expect(decrypt(parts.join(":"))).rejects.toThrow();
	});

	it("rejects an unrecognized format", async () => {
		await expect(decrypt("v3:k2:a:b:c")).rejects.toThrow(
			/Unrecognized ciphertext format/
		);
		await expect(decrypt("not-ciphertext")).rejects.toThrow(
			/Unrecognized ciphertext format/
		);
	});
});

describe("keyring refresh", () => {
	it("refetches once when it meets a key id it does not know", async () => {
		// A process holding a stale keyring meets a row written by a peer that
		// already rotated. The forced refetch is what keeps that from erroring.
		const fresh = { active: "k2", keys: { k1: KEY_A, k2: KEY_B } };
		useKeyring(fresh);
		const written = await encrypt("written-by-a-peer");

		const stale = { active: "k1", keys: { k1: KEY_A } };
		mockGetSecretJson.mockReset();
		mockGetSecretJson.mockImplementation(async (_name, opts = {}) =>
			opts.forceRefresh ? fresh : stale
		);
		resetKeyringCache();

		expect(await decrypt(written)).toBe("written-by-a-peer");
		expect(mockGetSecretJson).toHaveBeenCalledTimes(2);
	});

	it("throws when the key is gone even after a refresh", async () => {
		useKeyring({ active: "k2", keys: { k1: KEY_A, k2: KEY_B } });
		const written = await encrypt("orphaned");

		useKeyring({ active: "k3", keys: { k3: KEY_A } });
		await expect(decrypt(written)).rejects.toThrow(/No key k2 on the keyring/);
	});

	it("rejects a keyring whose active key is missing", async () => {
		useKeyring({ active: "k9", keys: { k1: KEY_A } });
		await expect(encrypt("x")).rejects.toThrow(/active key k9 is not present/);
	});

	it("rejects a key that is not 32 bytes of hex", async () => {
		useKeyring({ active: "k1", keys: { k1: "too-short" } });
		await expect(encrypt("x")).rejects.toThrow(/64 hex characters/);
	});
});

describe("pre-keyring back-compat", () => {
	it("keeps writing v1 when no keyring is configured", async () => {
		useKeyring(null);
		const payload = await encrypt("legacy-write");
		expect(payload.startsWith("v1:")).toBe(true);
		expect(keyIdOf(payload)).toBe("legacy");
		expect(await decrypt(payload)).toBe("legacy-write");
		expect(await needsReencrypt(payload)).toBe(false);
	});

	it("reads existing v1 rows once a keyring exists", async () => {
		useKeyring(null);
		const old = await encrypt("written-before-the-keyring");

		// A keyring that never heard of the legacy key: decrypt falls back to
		// the original derivation rather than failing.
		useKeyring({ active: "k1", keys: { k1: KEY_A } });
		expect(await decrypt(old)).toBe("written-before-the-keyring");
		expect(await needsReencrypt(old)).toBe(true);
	});

	it("reads v1 rows through a keyring carrying the legacy key", async () => {
		useKeyring(null);
		const old = await encrypt("seeded-legacy");

		// What the rotation job publishes on its first run.
		useKeyring({
			active: "k1",
			keys: { legacy: legacyKeyHex(), k1: KEY_A },
		});
		expect(await decrypt(old)).toBe("seeded-legacy");
	});
});

describe("rotation helpers", () => {
	it("generates distinct 32-byte hex keys", () => {
		const a = generateKeyHex();
		const b = generateKeyHex();
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(a).not.toBe(b);
	});

	it("reads a key id without decrypting, and null on garbage", () => {
		expect(keyIdOf("v2:k7:a:b:c")).toBe("k7");
		expect(keyIdOf("v1:a:b:c")).toBe("legacy");
		expect(keyIdOf("nonsense")).toBeNull();
		expect(keyIdOf(null)).toBeNull();
	});

	it("refuses to encrypt a non-string or empty value", async () => {
		useKeyring({ active: "k1", keys: { k1: KEY_A } });
		await expect(encrypt("")).rejects.toThrow(/non-empty string/);
		await expect(encrypt(null)).rejects.toThrow(/non-empty string/);
	});
});
