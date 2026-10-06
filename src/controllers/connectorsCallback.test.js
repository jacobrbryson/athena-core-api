/**
 * The shared Google callback: one redirect URI (a companion page) for every
 * Google flow, finished by POST /integrations/callback on the state alone.
 */
process.env.PUBLIC_API_BASE_URL = "https://api.athena.test/api/v1";

jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../services/integration", () => ({ resolveActingProfile: jest.fn() }));
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));
jest.mock("../services/connectors/oauth", () => {
	const actual = jest.requireActual("../services/connectors/oauth");
	return {
		...actual,
		stateProvider: jest.fn(),
		complete: jest.fn(),
		completeGroup: jest.fn(),
	};
});

const config = require("../config");
const oauth = require("../services/connectors/oauth");
const { completeCallback, handleCallback } = require("./connectors");

function res() {
	const r = { statusCode: 200 };
	r.set = jest.fn(() => r);
	r.status = jest.fn((code) => { r.statusCode = code; return r; });
	r.json = jest.fn((body) => { r.body = body; return r; });
	r.redirect = jest.fn((code, url) => { r.statusCode = code; r.location = url; return r; });
	return r;
}

afterEach(() => {
	jest.clearAllMocks();
	config.OAUTH_GOOGLE_CALLBACK_URL = "";
});

describe("redirectUri", () => {
	it("keeps per-provider callbacks while the shared one is unset", () => {
		expect(oauth.redirectUri("google_contacts")).toBe("https://api.athena.test/api/v1/integrations/google_contacts/callback");
	});

	it("sends every Google flow, and only Google's, to the shared page once set", () => {
		config.OAUTH_GOOGLE_CALLBACK_URL = "https://app.athena.test/oauth/google/callback";
		for (const id of ["gmail", "google_calendar", "google_contacts", "google"]) {
			expect(oauth.redirectUri(id)).toBe("https://app.athena.test/oauth/google/callback");
		}
		expect(oauth.redirectUri("whoop")).toBe("https://api.athena.test/api/v1/integrations/whoop/callback");
	});
});

describe("POST /integrations/callback", () => {
	it("finishes a Google provider's flow and answers with where to go", async () => {
		oauth.stateProvider.mockResolvedValue("google_contacts");
		oauth.complete.mockResolvedValue({ redirectTo: "https://app.athena.test/", credential: {} });
		const r = res();
		await completeCallback({ body: { code: "c", state: "s" } }, r);
		expect(oauth.complete).toHaveBeenCalledWith("google_contacts", expect.objectContaining({ code: "c", state: "s" }));
		expect(r.body).toEqual({ success: true, redirect: "https://app.athena.test/?integration=google_contacts&status=connected" });
	});

	it("finishes the sign-in group through the same page", async () => {
		oauth.stateProvider.mockResolvedValue("google");
		oauth.completeGroup.mockResolvedValue({ redirectTo: "https://app.athena.test/", linked: ["gmail"], kept: [], declined: [] });
		const r = res();
		await completeCallback({ body: { code: "c", state: "s" } }, r);
		expect(oauth.completeGroup).toHaveBeenCalledWith("google", expect.anything());
		expect(r.body.redirect).toContain("integration=google");
		expect(r.body.redirect).toContain("status=connected");
	});

	it("refuses another provider's state without consuming it", async () => {
		oauth.stateProvider.mockResolvedValue("whoop");
		const r = res();
		await completeCallback({ body: { code: "c", state: "s" } }, r);
		expect(r.statusCode).toBe(400);
		expect(oauth.complete).not.toHaveBeenCalled();
	});

	it("refuses an unknown, used or expired state", async () => {
		oauth.stateProvider.mockResolvedValue(null);
		const r = res();
		await completeCallback({ body: { code: "c", state: "nope" } }, r);
		expect(r.statusCode).toBe(400);
		expect(r.body.code).toBe("state_invalid");
	});

	it("sends a declined consent back to the app with the reason", async () => {
		oauth.stateProvider.mockResolvedValue("google_calendar");
		oauth.complete.mockRejectedValue(Object.assign(new Error("declined"), { status: 400, code: "access_denied", redirectTo: "https://app.athena.test/" }));
		const r = res();
		await completeCallback({ body: { error: "access_denied", state: "s" } }, r);
		expect(r.body.redirect).toBe("https://app.athena.test/?integration=google_calendar&status=error&reason=access_denied");
	});
});

describe("GET /integrations/:provider/callback still works", () => {
	it("redirects the browser as before", async () => {
		oauth.complete.mockResolvedValue({ redirectTo: "https://app.athena.test/", credential: {} });
		const r = res();
		await handleCallback({ params: { provider: "whoop" }, query: { code: "c", state: "s" } }, r);
		expect(r.redirect).toHaveBeenCalledWith(302, "https://app.athena.test/?integration=whoop&status=connected");
	});
});
