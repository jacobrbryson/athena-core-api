/**
 * Secret resolution: env precedence, caching, single-flight, and the
 * failure modes that must not turn into a Secret Manager call per request.
 */
process.env.GCP_PROJECT_ID = "athena-test";

const mockAccess = jest.fn();
const mockAddVersion = jest.fn();
const mockGetSecret = jest.fn();
const mockCreateSecret = jest.fn();

jest.mock("@google-cloud/secret-manager", () => ({
	SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
		accessSecretVersion: mockAccess,
		addSecretVersion: mockAddVersion,
		getSecret: mockGetSecret,
		createSecret: mockCreateSecret,
	})),
}));

const secrets = require("./index");

/** Shape of a successful accessSecretVersion response. */
function payload(value) {
	return [{ payload: { data: Buffer.from(value, "utf8") } }];
}

function notFound() {
	return Object.assign(new Error("NOT_FOUND"), { code: 5 });
}

beforeEach(() => {
	jest.clearAllMocks();
	secrets.clearCache();
	delete process.env.TEST_SECRET;
	jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("getSecret", () => {
	it("prefers the environment and never calls Secret Manager", async () => {
		process.env.TEST_SECRET = "from-env";
		expect(await secrets.getSecret("TEST_SECRET")).toBe("from-env");
		expect(mockAccess).not.toHaveBeenCalled();
	});

	it("ignores a blank env var and falls through to Secret Manager", async () => {
		process.env.TEST_SECRET = "   ";
		mockAccess.mockResolvedValue(payload("from-gsm"));
		expect(await secrets.getSecret("TEST_SECRET")).toBe("from-gsm");
	});

	it("reads the latest version by default", async () => {
		mockAccess.mockResolvedValue(payload("v-latest"));
		await secrets.getSecret("TEST_SECRET");
		expect(mockAccess).toHaveBeenCalledWith({
			name: "projects/athena-test/secrets/TEST_SECRET/versions/latest",
		});
	});

	it("caches a hit", async () => {
		mockAccess.mockResolvedValue(payload("cached"));
		expect(await secrets.getSecret("TEST_SECRET")).toBe("cached");
		expect(await secrets.getSecret("TEST_SECRET")).toBe("cached");
		expect(mockAccess).toHaveBeenCalledTimes(1);
	});

	it("bypasses and replaces the cache on forceRefresh", async () => {
		mockAccess.mockResolvedValueOnce(payload("old"));
		expect(await secrets.getSecret("TEST_SECRET")).toBe("old");

		mockAccess.mockResolvedValueOnce(payload("rotated"));
		expect(await secrets.getSecret("TEST_SECRET", { forceRefresh: true })).toBe(
			"rotated"
		);
		// The refreshed value is what subsequent cached reads get.
		expect(await secrets.getSecret("TEST_SECRET")).toBe("rotated");
		expect(mockAccess).toHaveBeenCalledTimes(2);
	});

	it("collapses concurrent misses into one call", async () => {
		mockAccess.mockResolvedValue(payload("single-flight"));
		const results = await Promise.all([
			secrets.getSecret("TEST_SECRET"),
			secrets.getSecret("TEST_SECRET"),
			secrets.getSecret("TEST_SECRET"),
		]);
		expect(results).toEqual([
			"single-flight",
			"single-flight",
			"single-flight",
		]);
		expect(mockAccess).toHaveBeenCalledTimes(1);
	});

	it("returns null and negative-caches a missing secret", async () => {
		mockAccess.mockRejectedValue(notFound());
		expect(await secrets.getSecret("TEST_SECRET")).toBeNull();
		expect(await secrets.getSecret("TEST_SECRET")).toBeNull();
		expect(mockAccess).toHaveBeenCalledTimes(1);
	});

	it("retries immediately after a transient failure", async () => {
		mockAccess.mockRejectedValueOnce(
			Object.assign(new Error("UNAVAILABLE"), { code: 14 })
		);
		expect(await secrets.getSecret("TEST_SECRET")).toBeNull();

		mockAccess.mockResolvedValueOnce(payload("recovered"));
		expect(await secrets.getSecret("TEST_SECRET")).toBe("recovered");
		expect(mockAccess).toHaveBeenCalledTimes(2);
	});

	it("requires a name", async () => {
		await expect(secrets.getSecret("")).rejects.toThrow(/requires a secret name/);
	});
});

describe("getSecretJson", () => {
	it("parses a JSON payload", async () => {
		mockAccess.mockResolvedValue(payload('{"active":"k1","keys":{}}'));
		expect(await secrets.getSecretJson("TEST_SECRET")).toEqual({
			active: "k1",
			keys: {},
		});
	});

	it("returns null rather than throwing on unparseable JSON", async () => {
		mockAccess.mockResolvedValue(payload("{not json"));
		expect(await secrets.getSecretJson("TEST_SECRET")).toBeNull();
	});

	it("returns null on a miss", async () => {
		mockAccess.mockRejectedValue(notFound());
		expect(await secrets.getSecretJson("TEST_SECRET")).toBeNull();
	});
});

describe("requireSecret", () => {
	it("throws a name-carrying error when unset", async () => {
		mockAccess.mockRejectedValue(notFound());
		await expect(secrets.requireSecret("TEST_SECRET")).rejects.toThrow(
			/Required secret TEST_SECRET is not configured/
		);
	});
});

describe("addSecretVersion", () => {
	it("adds a version to an existing secret and drops the cached value", async () => {
		mockAccess.mockResolvedValue(payload("stale"));
		expect(await secrets.getSecret("TEST_SECRET")).toBe("stale");

		mockAddVersion.mockResolvedValue([
			{ name: "projects/athena-test/secrets/TEST_SECRET/versions/2" },
		]);
		await secrets.addSecretVersion("TEST_SECRET", "new-value");

		// The happy path must not need secrets.get or secrets.create — that is
		// what lets the rotation job hold secretVersionAdder and nothing more.
		expect(mockGetSecret).not.toHaveBeenCalled();
		expect(mockCreateSecret).not.toHaveBeenCalled();
		expect(mockAddVersion).toHaveBeenCalledWith({
			parent: "projects/athena-test/secrets/TEST_SECRET",
			payload: { data: Buffer.from("new-value", "utf8") },
		});

		// The superseded value must not still be served from cache.
		mockAccess.mockResolvedValue(payload("new-value"));
		expect(await secrets.getSecret("TEST_SECRET")).toBe("new-value");
	});

	it("creates the secret when it does not exist yet, then adds the version", async () => {
		mockAddVersion.mockRejectedValueOnce(notFound());
		mockCreateSecret.mockResolvedValue([{}]);
		mockAddVersion.mockResolvedValueOnce([{}]);

		await secrets.addSecretVersion("NEW_SECRET", "value");
		expect(mockCreateSecret).toHaveBeenCalledWith({
			parent: "projects/athena-test",
			secretId: "NEW_SECRET",
			secret: { replication: { automatic: {} } },
		});
		expect(mockAddVersion).toHaveBeenCalledTimes(2);
	});

	it("propagates a permission error rather than trying to create", async () => {
		mockAddVersion.mockRejectedValue(
			Object.assign(new Error("PERMISSION_DENIED"), { code: 7 })
		);
		await expect(
			secrets.addSecretVersion("TEST_SECRET", "value")
		).rejects.toThrow(/PERMISSION_DENIED/);
		expect(mockCreateSecret).not.toHaveBeenCalled();
	});
});
