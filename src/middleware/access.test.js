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
	for (const provider of ["google_calendar", "whoop"]) {
		await expect(run(`/integrations/${provider}/callback`)).resolves.toEqual({ next: true });
	}
});

test("only the callback is public under /integrations", async () => {
	for (const path of ["/integrations", "/integrations/whoop", "/integrations/whoop/connect"]) {
		await expect(run(path)).resolves.toMatchObject({ status: 401 });
	}
});

test("the callback exemption is GET-only", async () => {
	await expect(
		run("/integrations/whoop/callback", { method: "POST" })
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

test("the shared Google callback is public as a POST to that exact path only", async () => {
	await expect(run("/integrations/callback", { method: "POST" })).resolves.toEqual({ next: true });
	await expect(run("/integrations/callback")).resolves.toMatchObject({ status: 401 });
	await expect(run("/integrations/callback/extra", { method: "POST" })).resolves.toMatchObject({ status: 401 });
	await expect(run("/integrations/google/connect", { method: "POST" })).resolves.toMatchObject({ status: 401 });
});

describe("Family Chores partner calls (owner, 2026-10-15)", () => {
	const security = require("../security/access");
	// What the route behind the boundary would see in the access context.
	function runSeeing(path, method = "POST", headers = {}) {
		return new Promise((resolve) => {
			const res = { set: () => res, status(c) { res._status = c; return res; }, json(body) { resolve({ status: res._status || 200, body }); return res; } };
			accessBoundary({ path, method, headers }, res, () => resolve({ next: true, store: security.context.getStore() }));
		});
	}
	afterEach(() => { delete process.env.FAMILY_CHORES_PARTNER_GOOGLE_ID; });

	test("connect and disconnect pass with no user identity at all", async () => {
		for (const path of ["/integrations/family-chores/connect", "/integrations/family-chores/disconnect"]) {
			await expect(runSeeing(path)).resolves.toEqual({ next: true, store: { identity: null, partner: "family_chores" } });
		}
	});

	test("the proxy's service token is never read as a user", async () => {
		decodeUserToken.mockClear();
		decodeUserToken.mockReturnValue({ google_id: "someone" });
		await expect(runSeeing("/integrations/family-chores/connect", "POST", { authorization: "Bearer service-token" }))
			.resolves.toMatchObject({ store: { identity: null } });
		expect(decodeUserToken).not.toHaveBeenCalled();
	});

	test("suggestions are charged to FAMILY_CHORES_PARTNER_GOOGLE_ID, and to no one when it is unset", async () => {
		await expect(runSeeing("/integrations/family-chores/suggest-chores")).resolves.toMatchObject({ store: { identity: null } });
		process.env.FAMILY_CHORES_PARTNER_GOOGLE_ID = " 1061 ";
		for (const path of ["/integrations/family-chores/suggest-chores", "/integrations/family-chores/suggest-ghost-chores"]) {
			await expect(runSeeing(path)).resolves.toMatchObject({ store: { identity: { google_id: "1061" } } });
		}
		// Connect never gets the model identity.
		await expect(runSeeing("/integrations/family-chores/connect")).resolves.toMatchObject({ store: { identity: null } });
	});

	test("only those four, only as POST", async () => {
		process.env.FAMILY_CHORES_PARTNER_GOOGLE_ID = "1061";
		for (const path of [
			"/integrations/family-chores/remember",
			"/integrations/family-chores/children",
			"/integrations/family-chores/connect-child",
			"/integrations/family-chores/disconnect-child",
			"/integrations/family-chores/connect/extra",
			"/integrations/family-chores",
			"/integrations/family_chores/connect",
		]) {
			await expect(run(path, { method: "POST" })).resolves.toMatchObject({ status: 401 });
		}
		await expect(run("/integrations/family-chores/connect")).resolves.toMatchObject({ status: 401 });
		await expect(run("/integrations/family-chores/suggest-chores")).resolves.toMatchObject({ status: 401 });
	});
});
