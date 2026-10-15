/**
 * The Family Chores partner secret is the only thing authorizing the partner
 * endpoints once the access boundary lets them through (2026-10-15), so it
 * must fail closed and match exactly.
 */
jest.mock("../config", () => ({ FAMILY_CHORES_PARTNER_SECRET: "" }));
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../helpers/crypto", () => ({ encrypt: jest.fn(), decrypt: jest.fn() }));
jest.mock("./parent-helpers", () => ({}));
jest.mock("./family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("./profile", () => ({ getProfileByEmail: jest.fn() }));
jest.mock("./familyChores", () => ({}));
jest.mock("./choreSuggestions", () => ({ generateChoreSuggestions: jest.fn(async () => ["Feed the fish"]) }));
jest.mock("./ghostChoreSuggestions", () => ({ generateGhostChoreSuggestions: jest.fn() }));
jest.mock("./memory", () => ({}));
jest.mock("./gemini", () => ({}));
jest.mock("./familyChoresTools", () => ({}));

const config = require("../config");
const choreSuggestions = require("./choreSuggestions");
const integration = require("./integration");

const SECRET = "s3cret-partner-value";

beforeEach(() => {
	jest.clearAllMocks();
	config.FAMILY_CHORES_PARTNER_SECRET = SECRET;
});

test("an unset secret refuses every partner call instead of allowing it", async () => {
	config.FAMILY_CHORES_PARTNER_SECRET = "";
	await expect(integration.suggestChores({ partnerSecret: "anything" })).rejects.toMatchObject({ status: 503 });
	await expect(integration.suggestChores({})).rejects.toMatchObject({ status: 503 });
	expect(choreSuggestions.generateChoreSuggestions).not.toHaveBeenCalled();
});

test("a missing, wrong or near-miss secret is a 401 and runs nothing", async () => {
	for (const partnerSecret of [undefined, "", "wrong", `${SECRET} `, SECRET.slice(0, -1), SECRET.toUpperCase()]) {
		await expect(integration.suggestChores({ partnerSecret })).rejects.toMatchObject({ status: 401 });
	}
	await expect(integration.connectFamilyChores({ partnerSecret: "wrong", apiToken: "t" })).rejects.toMatchObject({ status: 401 });
	expect(choreSuggestions.generateChoreSuggestions).not.toHaveBeenCalled();
});

test("the exact secret goes through", async () => {
	await integration.suggestChores({ partnerSecret: SECRET, child: { name: "Eli" } });
	expect(choreSuggestions.generateChoreSuggestions).toHaveBeenCalled();
});
