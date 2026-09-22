/**
 * The Authorization header actually reaching FCM.
 *
 * google-auth-library 10 returns a WHATWG `Headers` object from
 * getRequestHeaders(), and `{...headers}` on one of those is `{}` — so the
 * bearer token vanished and every Android push came back UNAUTHENTICATED while
 * browser push (VAPID, no Google auth) carried on working. The owner's phone
 * was silently unreachable for as long as that library version had been in.
 *
 * This asserts on what leaves the process, so the same class of bug cannot
 * come back through another library upgrade.
 */
jest.mock("../secrets", () => ({
	getSecretJson: jest.fn().mockResolvedValue({
		client_email: "fcm@athena-476423.iam.gserviceaccount.com",
		private_key: "unused-by-the-mocked-JWT",
		project_id: "athena-476423",
	}),
	getSecret: jest.fn(),
}));

jest.mock("google-auth-library", () => ({
	JWT: class {
		// Exactly what the real library hands back now.
		async getRequestHeaders() {
			return new Headers({ authorization: "Bearer test-token" });
		}
	},
}));

const fcm = require("./fcm");

describe("fcm.send", () => {
	let sent;
	beforeEach(() => {
		fcm.reset();
		sent = null;
		global.fetch = jest.fn(async (url, init) => {
			sent = { url, init };
			return { ok: true, status: 200, text: async () => "" };
		});
	});

	test("sends the bearer token FCM needs", async () => {
		const result = await fcm.send("device-token", { title: "Athena", body: "Structure fire nearby" });
		expect(result).toEqual({ ok: true });
		const headers = new Headers(sent.init.headers);
		expect(headers.get("authorization")).toBe("Bearer test-token");
		expect(headers.get("content-type")).toBe("application/json");
	});

	test("posts to the project's messages:send with the notification", async () => {
		await fcm.send("device-token", { title: "Athena", body: "Tree down", data: { uuid: 7 } });
		expect(sent.url).toContain("/v1/projects/athena-476423/messages:send");
		const body = JSON.parse(sent.init.body);
		expect(body.message.token).toBe("device-token");
		expect(body.message.notification).toEqual({ title: "Athena", body: "Tree down" });
		// Every data value must be a string or FCM rejects the whole message.
		expect(body.message.data.uuid).toBe("7");
	});
});
