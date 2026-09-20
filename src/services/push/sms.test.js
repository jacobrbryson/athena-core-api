/**
 * The SMS transport.
 *
 * The cases that matter are the ones that cost money or consent: a number
 * normalised wrongly texts a stranger, and a STOP that gets quietly undone is
 * the worst bug this module could have.
 */
jest.mock("../secrets", () => ({ getSecret: jest.fn() }));

const secrets = require("../secrets");
const sms = require("./sms");

const CONFIG = {
	TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
	TWILIO_SID: "SK" + "1".repeat(32),
	TWILIO_CLIENT_SECRET: "a-secret",
	TWILIO_FROM_NUMBER: "+15555550100",
};

function twilioReplies(status, body) {
	global.fetch = jest.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	sms.reset();
	secrets.getSecret.mockImplementation(async (name) => CONFIG[name] ?? null);
	twilioReplies(201, { sid: "SM1" });
});

afterEach(() => {
	delete global.fetch;
});

describe("normalising a number", () => {
	test("accepts what a person actually types", () => {
		expect(sms.normalizeNumber("(555) 555-0123")).toBe("+15555550123");
		expect(sms.normalizeNumber("555-555-0123")).toBe("+15555550123");
		expect(sms.normalizeNumber("15555550123")).toBe("+15555550123");
		expect(sms.normalizeNumber("+15555550123")).toBe("+15555550123");
		expect(sms.normalizeNumber(" +44 20 7946 0958 ")).toBe("+442079460958");
	});

	test("refuses anything it cannot be sure about", () => {
		// A typo'd number is not a send that fails — it is a real stranger
		// receiving somebody else's private reminders, and a bill for it.
		expect(sms.normalizeNumber("555-0123")).toBeNull();
		expect(sms.normalizeNumber("not a number")).toBeNull();
		expect(sms.normalizeNumber("+0123456789")).toBeNull();
		expect(sms.normalizeNumber("")).toBeNull();
		expect(sms.normalizeNumber(null)).toBeNull();
	});
});

describe("sending", () => {
	test("posts the message to the account's own path", async () => {
		const result = await sms.send("+15555550123", { body: "Your 2pm is soon." });

		expect(result).toEqual({ ok: true });
		const [url, init] = global.fetch.mock.calls[0];
		expect(url).toContain(`/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages.json`);
		const sent = new URLSearchParams(init.body);
		expect(sent.get("To")).toBe("+15555550123");
		expect(sent.get("From")).toBe(CONFIG.TWILIO_FROM_NUMBER);
		expect(sent.get("Body")).toBe("Athena: Your 2pm is soon.");
	});

	test("authenticates with the API key, not the account's auth token", async () => {
		// An API key can be revoked on its own; the account auth token cannot.
		await sms.send("+15555550123", { body: "hi" });
		const [, init] = global.fetch.mock.calls[0];
		const decoded = Buffer.from(
			init.headers.Authorization.replace("Basic ", ""),
			"base64"
		).toString();
		expect(decoded).toBe(`${CONFIG.TWILIO_SID}:${CONFIG.TWILIO_CLIENT_SECRET}`);
	});

	test("falls back to the account sid when no API key is configured", async () => {
		secrets.getSecret.mockImplementation(async (name) =>
			name === "TWILIO_SID" ? null : (CONFIG[name] ?? null)
		);
		await sms.send("+15555550123", { body: "hi" });
		const [, init] = global.fetch.mock.calls[0];
		const decoded = Buffer.from(
			init.headers.Authorization.replace("Basic ", ""),
			"base64"
		).toString();
		expect(decoded.startsWith(`${CONFIG.TWILIO_ACCOUNT_SID}:`)).toBe(true);
	});

	test("identifies the sender even when a title is provided", async () => {
		await sms.send("+15555550123", { title: "Athena", body: "Your 2pm is soon." });
		const sent = new URLSearchParams(global.fetch.mock.calls[0][1].body);
		expect(sent.get("Body")).toBe("Athena: Your 2pm is soon.");
	});

	test("a malformed number never reaches Twilio", async () => {
		const result = await sms.send("nonsense", { body: "hi" });
		expect(result).toMatchObject({ ok: false, dead: true, reason: "MALFORMED_NUMBER" });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	test("an unconfigured server is a quiet no-op, not an error", async () => {
		secrets.getSecret.mockResolvedValue(null);
		const result = await sms.send("+15555550123", { body: "hi" });
		expect(result).toMatchObject({ ok: false, dead: false, reason: "not_configured" });
		expect(global.fetch).not.toHaveBeenCalled();
	});
});

describe("consent and failure", () => {
	test("a STOP reply is permanent — the registration is dead", async () => {
		// 21610. The one error that must never be retried or repaired: a STOP
		// undone by the next re-registration is an unsolicited-messaging
		// violation, not a glitch.
		twilioReplies(400, { code: 21610, message: "unsubscribed recipient" });
		const result = await sms.send("+15555550123", { body: "hi" });
		expect(result).toMatchObject({ ok: false, dead: true, reason: "TWILIO_21610" });
	});

	test("an unreachable number is dead, so it stops being retried", async () => {
		twilioReplies(400, { code: 21614, message: "not a mobile number" });
		expect(await sms.send("+15555550123", { body: "hi" })).toMatchObject({ dead: true });
	});

	test("a rate limit is TRANSIENT and never costs the registration", async () => {
		// Clearing on a 429 would silently unsubscribe someone from messages
		// they asked for, with nothing in the UI to explain it.
		twilioReplies(429, { code: 20429, message: "too many requests" });
		expect(await sms.send("+15555550123", { body: "hi" })).toMatchObject({
			ok: false,
			dead: false,
		});
	});

	test("a server error is transient too", async () => {
		twilioReplies(500, { code: 20500 });
		expect(await sms.send("+15555550123", { body: "hi" })).toMatchObject({ dead: false });
	});

	test("a network failure is reported, not thrown", async () => {
		// One unreachable number must not fail the pass that was trying to
		// reach five other places.
		global.fetch = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
		const result = await sms.send("+15555550123", { body: "hi" });
		expect(result).toMatchObject({ ok: false, dead: false, reason: "ECONNRESET" });
	});
});

describe("configuration", () => {
	test("isConfigured is false without a from number", async () => {
		secrets.getSecret.mockImplementation(async (name) =>
			name === "TWILIO_FROM_NUMBER" ? null : (CONFIG[name] ?? null)
		);
		expect(await sms.isConfigured()).toBe(false);
	});

	test("isConfigured is true with the full set", async () => {
		expect(await sms.isConfigured()).toBe(true);
	});
});
