jest.mock("./auth", () => ({ decodeUserToken: jest.fn(() => null) }));
jest.mock("../security/access", () => {
	const { AsyncLocalStorage } = require("node:async_hooks");
	return {
		context: new AsyncLocalStorage(),
		allowed: jest.fn(async () => true),
		recordVisit: jest.fn(async () => ({ allowed: true, requested: false })),
	};
});

const { decodeUserToken } = require("./auth");
const { accessBoundary } = require("./access");

/**
 * Drives the boundary and reports which way it went: `next` when the request
 * was let through, or the status + body it answered with.
 */
function run(path, { method = "GET", headers = {} } = {}) {
	return new Promise((resolve) => {
		const res = {
			set: () => res,
			status(code) {
				res._status = code;
				return res;
			},
			json(body) {
				resolve({ status: res._status || 200, body });
				return res;
			},
		};
		accessBoundary({ path, method, headers }, res, () => resolve({ next: true }));
	});
}

beforeEach(() => decodeUserToken.mockReturnValue(null));

test("the connector OAuth callback is public — the provider redirects a browser here with no session", async () => {
	// Regression: the callback used to 401 with "Sign in required", which the
	// proxy relayed into the address bar instead of the 302 back to the app.
	for (const provider of ["google_calendar", "strava", "whoop"]) {
		await expect(run(`/integrations/${provider}/callback`)).resolves.toEqual({ next: true });
	}
});

test("only the callback is public under /integrations", async () => {
	for (const path of ["/integrations", "/integrations/strava", "/integrations/strava/connect"]) {
		await expect(run(path)).resolves.toMatchObject({ status: 401 });
	}
});

test("the callback exemption is GET-only", async () => {
	await expect(
		run("/integrations/strava/callback", { method: "POST" })
	).resolves.toMatchObject({ status: 401 });
});

test("an unauthenticated request to an ordinary route still fails closed", async () => {
	await expect(run("/message")).resolves.toEqual({
		status: 401,
		body: { message: "Sign in required" },
	});
});

test("the existing public paths still pass", async () => {
	await expect(run("/modes")).resolves.toEqual({ next: true });
	await expect(run("/auth/guardian/validate", { method: "POST" })).resolves.toEqual({
		next: true,
	});
});
