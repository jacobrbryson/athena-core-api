/**
 * Inbound SMS.
 *
 * Weighted almost entirely toward refusal, because this is the one endpoint in
 * the API with no session and no device token behind it. The only thing
 * standing between "a text from Ross" and "a POST from anyone who found the
 * URL" is the signature check, so that is what these tests are about.
 */
jest.mock("../services/secrets", () => ({ getSecret: jest.fn() }));
jest.mock("../services/push", () => ({
	profileForNumber: jest.fn(),
	forgetPhone: jest.fn(),
}));
jest.mock("../services/push/sms", () => ({
	send: jest.fn(),
	normalizeNumber: jest.requireActual("../services/push/sms").normalizeNumber,
}));
jest.mock("../services/session", () => ({ getOrCreateForProfile: jest.fn() }));
jest.mock("../services/message", () => ({ addMessage: jest.fn(), getMessages: jest.fn() }));
jest.mock("./gemini", () => ({ processAiResponse: jest.fn() }));

const crypto = require("node:crypto");
const secrets = require("../services/secrets");
const push = require("../services/push");
const sms = require("../services/push/sms");
const sessionService = require("../services/session");
const messageService = require("../services/message");
const { processAiResponse } = require("./gemini");
const controller = require("./sms");

const AUTH_TOKEN = "an-account-auth-token";
const URL = "https://api.example.com/api/v1/sms/inbound";

/** Sign exactly the way Twilio does, so a valid request is really valid. */
function sign(url, params, token = AUTH_TOKEN) {
	const payload = Object.keys(params)
		.sort()
		.reduce((acc, k) => acc + k + params[k], url);
	return crypto.createHmac("sha1", token).update(Buffer.from(payload, "utf-8")).digest("base64");
}

function request(params, signature) {
	return {
		body: params,
		originalUrl: "/api/v1/sms/inbound",
		get: (h) => {
			const key = String(h).toLowerCase();
			if (key === "x-twilio-signature") return signature;
			if (key === "host") return "api.example.com";
			return undefined;
		},
	};
}

function response() {
	const res = {
		statusCode: null,
		body: null,
		set: jest.fn(() => res),
		status: jest.fn((c) => {
			res.statusCode = c;
			return res;
		}),
		send: jest.fn((b) => {
			res.body = b;
			return res;
		}),
	};
	return res;
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
	jest.clearAllMocks();
	secrets.getSecret.mockImplementation(async (name) => {
		if (name === "TWILIO_AUTH_TOKEN") return AUTH_TOKEN;
		if (name === "TWILIO_WEBHOOK_URL") return URL;
		return null;
	});
	push.profileForNumber.mockResolvedValue({ deviceId: 3, profileId: 42 });
	push.forgetPhone.mockResolvedValue({ registered: false });
	sms.send.mockResolvedValue({ ok: true });
	sessionService.getOrCreateForProfile.mockResolvedValue({ id: 9, uuid: "s-1", profile_id: 42 });
	messageService.addMessage.mockResolvedValue("m-1");
	messageService.getMessages.mockResolvedValue([
		{ is_human: true, text: "what time again?" },
		{ is_human: false, text: "Two o'clock." },
	]);
	processAiResponse.mockResolvedValue(undefined);
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("the signature is the whole door", () => {
	test("an unsigned request is refused before anything is looked up", async () => {
		const params = { From: "+15555550123", Body: "read me my calendar" };
		const res = response();
		await controller.inbound(request(params, undefined), res);

		expect(res.statusCode).toBe(403);
		// Not merely "no reply" — nothing may be touched at all. This is the
		// difference between a refusal and a leak.
		expect(push.profileForNumber).not.toHaveBeenCalled();
		expect(processAiResponse).not.toHaveBeenCalled();
	});

	test("a signature from the wrong key is refused", async () => {
		const params = { From: "+15555550123", Body: "hello" };
		const res = response();
		await controller.inbound(request(params, sign(URL, params, "not-the-token")), res);

		expect(res.statusCode).toBe(403);
		expect(processAiResponse).not.toHaveBeenCalled();
	});

	test("a signature over different parameters is refused", async () => {
		// The attack this stops: replaying a legitimately signed request with
		// the From number swapped for somebody else's.
		const signed = { From: "+15555550123", Body: "hello" };
		const tampered = { From: "+15555559999", Body: "hello" };
		const res = response();
		await controller.inbound(request(tampered, sign(URL, signed)), res);

		expect(res.statusCode).toBe(403);
		expect(processAiResponse).not.toHaveBeenCalled();
	});

	test("a correctly signed request is accepted", async () => {
		const params = { From: "+15555550123", Body: "what time again?" };
		const res = response();
		await controller.inbound(request(params, sign(URL, params)), res);
		await flush();

		expect(res.statusCode).toBe(200);
		expect(processAiResponse).toHaveBeenCalled();
	});

	test("without an auth token the webhook refuses rather than trusts", async () => {
		// An unverifiable webhook is strictly worse than a missing one: it
		// would accept anything, from anyone, as any registered number.
		secrets.getSecret.mockResolvedValue(null);
		const params = { From: "+15555550123", Body: "hello" };
		const res = response();
		await controller.inbound(request(params, sign(URL, params)), res);

		expect(res.statusCode).toBe(503);
		expect(processAiResponse).not.toHaveBeenCalled();
	});
});

describe("who is allowed to be answered", () => {
	test("an unknown number gets silence, not a denial", async () => {
		// Saying "you are not registered" confirms to anyone texting at random
		// that they found a live system, and lets a number be tested for
		// membership by watching which ones get an answer.
		push.profileForNumber.mockResolvedValue(null);
		const params = { From: "+15555550000", Body: "who is this?" };
		const res = response();
		await controller.inbound(request(params, sign(URL, params)), res);
		await flush();

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("<Response/>");
		expect(processAiResponse).not.toHaveBeenCalled();
		expect(sms.send).not.toHaveBeenCalled();
	});

	test("STOP clears the registration instead of being answered", async () => {
		const params = { From: "+15555550123", Body: "STOP" };
		const res = response();
		await controller.inbound(request(params, sign(URL, params)), res);
		await flush();

		// The carrier has already actioned it. Our side has to agree, or she
		// would keep trying to reach somebody who withdrew consent.
		expect(push.forgetPhone).toHaveBeenCalledWith(42);
		expect(processAiResponse).not.toHaveBeenCalled();
		expect(sms.send).not.toHaveBeenCalled();
	});

	test("HELP is left to the carrier and never reaches the model", async () => {
		const params = { From: "+15555550123", Body: "help" };
		const res = response();
		await controller.inbound(request(params, sign(URL, params)), res);
		await flush();

		expect(processAiResponse).not.toHaveBeenCalled();
		expect(push.forgetPhone).not.toHaveBeenCalled();
	});
});

describe("answering", () => {
	test("the text joins the person's existing conversation", async () => {
		await controller._answer(42, "+15555550123", "what time again?");

		// Not a session per message: a separate thread would give her a second,
		// thinner memory of the same person.
		expect(sessionService.getOrCreateForProfile).toHaveBeenCalledWith(42);
		expect(messageService.addMessage).toHaveBeenCalledWith(9, true, "what time again?", null, 42);
	});

	test("her answer goes back by text, on the channel they used", async () => {
		await controller._answer(42, "+15555550123", "what time again?");

		expect(sms.send).toHaveBeenCalledWith("+15555550123", { body: "Two o'clock." });
	});

	test("the webhook is answered without waiting for the model", async () => {
		// Twilio times out at 15 seconds and retries, which would mean the same
		// message answered twice. So inbound must return having responded, with
		// the thinking still in flight.
		let resolveModel;
		processAiResponse.mockReturnValue(
			new Promise((r) => {
				resolveModel = r;
			})
		);
		const params = { From: "+15555550123", Body: "slow one" };
		const res = response();

		await controller.inbound(request(params, sign(URL, params)), res);

		expect(res.statusCode).toBe(200);
		expect(sms.send).not.toHaveBeenCalled();
		resolveModel();
		await flush();
	});

	test("a model that says nothing sends no empty text", async () => {
		messageService.getMessages.mockResolvedValue([{ is_human: true, text: "hi" }]);
		await controller._answer(42, "+15555550123", "hi");

		expect(sms.send).not.toHaveBeenCalled();
	});
});
