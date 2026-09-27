/**
 * addChild must never link a parent to themselves or to another adult: the
 * email path matches any profile, and a parent who typed their own email for
 * a child without one became their own child (and was later classified as a
 * child by audience.js).
 */
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));
jest.mock("../helpers/db", () => ({ query: jest.fn() }));

const conn = { query: jest.fn() };
const mockHelpers = {
	withTransaction: jest.fn((fn) => fn(conn)),
	getProfileByGoogleId: jest.fn(),
	getChildProfile: jest.fn(),
	ensureChildProfileByEmail: jest.fn(),
	extractChildIdentifiers: jest.fn(),
	syncHasGuardian: jest.fn(),
};
jest.mock("./parent-helpers", () => ({
	...jest.requireActual("./parent-helpers"),
	...mockHelpers,
}));

const { addChild } = require("./parent");

beforeEach(() => {
	jest.clearAllMocks();
	conn.query.mockResolvedValue([[]]);
	mockHelpers.withTransaction.mockImplementation((fn) => fn(conn));
	mockHelpers.getProfileByGoogleId.mockResolvedValue({ id: 6, uuid: "p", google_id: "g" });
	// No child identifier -> the email path.
	mockHelpers.extractChildIdentifiers.mockImplementation(() => {
		throw new Error("A child identifier is required");
	});
});

test("refuses the parent's own email", async () => {
	mockHelpers.ensureChildProfileByEmail.mockResolvedValue({ id: 6, is_guardian: true });
	await expect(addChild("g", { email: "me@example.com", full_name: "Kid" })).rejects.toThrow(/your own account/);
	expect(conn.query).not.toHaveBeenCalled();
});

test("refuses another adult's email", async () => {
	mockHelpers.ensureChildProfileByEmail.mockResolvedValue({ id: 9, is_guardian: 1 });
	await expect(addChild("g", { email: "other@example.com" })).rejects.toThrow(/adult account/);
	expect(conn.query).not.toHaveBeenCalled();
});

test("refuses the parent's own profile by identifier", async () => {
	mockHelpers.extractChildIdentifiers.mockReturnValue({ childUuid: "p" });
	mockHelpers.getChildProfile.mockResolvedValue({ id: 6, is_guardian: 0 });
	await expect(addChild("g", { child_uuid: "p" })).rejects.toThrow(/your own account/);
});
