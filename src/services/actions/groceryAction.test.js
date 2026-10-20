jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));
jest.mock("../codeAgents", () => ({ REPOS: {}, mayUse: jest.fn().mockResolvedValue(false) }));
jest.mock("../connectors/googleKeep", () => ({
	groceryTarget: jest.fn(), updateGroceryItem: jest.fn(), updateGroceryItems: jest.fn(),
	itemKey: (text) => String(text).toLowerCase().replace(/\s+/g, " ").trim(),
}));

const keep = require("../connectors/googleKeep");
const credentials = require("../credentials");
const consent = require("../consent");
const registry = require("./registry");
const actions = require("./index");
const action = registry.get("update_grocery_list");

beforeEach(() => {
	jest.clearAllMocks();
	credentials.list.mockResolvedValue([]);
	consent.hasConsentForProfile.mockResolvedValue(true);
	keep.groceryTarget.mockResolvedValue({ id: "shared-list", title: "Groceries", items: [
		{ text: "Eggs", checked: true }, { text: "milk", checked: false },
	] });
});

test("is proposed only for a linked Keep account with action consent and never gets standing approval", async () => {
	expect(action).toMatchObject({ provider: "google_keep", consentType: "action_authority", standing: false, reversible: true });
	expect(registry.paramsSchema().properties.operation.enum).toEqual(["add", "bought"]);
	expect((await actions.availableFor(42)).map((a) => a.id)).not.toContain(action.id);
	credentials.list.mockResolvedValue([{ provider: "google_keep", status: "active" }]);
	expect((await actions.availableFor(42)).map((a) => a.id)).toContain(action.id);
	consent.hasConsentForProfile.mockResolvedValue(false);
	expect((await actions.availableFor(42)).map((a) => a.id)).not.toContain(action.id);
	await expect(actions.grantAuthority(42, action.id)).rejects.toMatchObject({ code: "standing_not_allowed" });
});

test("normalizes a single new item against the caller's actual shared list", async () => {
	const params = await action.normalize({ operation: "add", item: " bananas ", list_title: "Groceries", list_id: "other" }, { profileId: 42 });
	expect(keep.groceryTarget).toHaveBeenCalledWith(42, "Groceries");
	expect(params).toEqual({ list_id: "shared-list", list_title: "Groceries", item: "bananas", operation: "add" });
	expect(action.summarize(params)).toBe('Add "bananas" to "Groceries" in Google Keep');
	keep.updateGroceryItem.mockResolvedValue({ ref: "item-1", detail: null });
	await action.execute(42, params);
	expect(keep.updateGroceryItem).toHaveBeenCalledWith(42, params);
});

test("proposes three additions on one card and skips an item already open", async () => {
	keep.groceryTarget.mockResolvedValue({ id: "shared-list", title: "Groceries", items: [
		{ text: "Apples", checked: true }, { text: "bananas", checked: false },
	] });
	const params = await action.normalize({ operation: "add", grocery_items: ["apples", "bananas", "blueberries"] }, { profileId: 42 });
	expect(params).toEqual({ list_id: "shared-list", list_title: "Groceries", grocery_items: ["Apples", "blueberries"], already_on_list: ["bananas"], operation: "add" });
	expect(action.summarize(params)).toBe('Add "Apples", "blueberries" to "Groceries" in Google Keep; already on list: "bananas"');
	await action.execute(42, params);
	expect(keep.updateGroceryItems).toHaveBeenCalledWith(42, params);
	expect(keep.updateGroceryItem).not.toHaveBeenCalled();
});

test("rejects invalid bundles and no-op bundles", async () => {
	await expect(action.normalize({ operation: "add", grocery_items: ["apples", " APPLES "] }, { profileId: 42 })).rejects.toThrow(/only once/);
	await expect(action.normalize({ operation: "add", grocery_items: ["apples, bananas"] }, { profileId: 42 })).rejects.toThrow(/each grocery/);
	await expect(action.normalize({ operation: "add", grocery_items: Array(11).fill("apples") }, { profileId: 42 })).rejects.toThrow(/1-10/);
	await expect(action.normalize({ operation: "bought", grocery_items: ["milk"] }, { profileId: 42 })).rejects.toThrow(/1-10/);
	expect(await action.normalize({ operation: "add", item: "apples", grocery_items: ["apples", "blueberries"] }, { profileId: 42 })).toMatchObject({ grocery_items: ["apples", "blueberries"] });
	await expect(action.normalize({ operation: "add", grocery_items: ["milk"] }, { profileId: 42 })).rejects.toThrow(/already on/);
	await expect(action.normalize({ operation: "add", grocery_items: Array.from({ length: 10 }, (_, i) => `${i}${"x".repeat(80)}`) }, { profileId: 42 })).rejects.toThrow(/split the request/);
	expect(registry.paramsSchema().properties.grocery_items).toEqual({ type: "array", items: { type: "string" } });
});

test("unticks a regular, or ticks only an open item", async () => {
	expect(await action.normalize({ operation: "add", item: "eggs" }, { profileId: 42 })).toMatchObject({ item: "Eggs", operation: "add" });
	expect(await action.normalize({ operation: "bought", item: "MILK" }, { profileId: 42 })).toMatchObject({ item: "milk", operation: "bought" });
	await expect(action.normalize({ operation: "add", item: "milk" }, { profileId: 42 })).rejects.toThrow(/already/);
	await expect(action.normalize({ operation: "bought", item: "Eggs" }, { profileId: 42 })).rejects.toThrow(/not waiting/);
});

test("reopens one of many checked copies, but never duplicates an open item", async () => {
	await expect(action.normalize({ operation: "add", item: "bananas, milk" }, { profileId: 42 })).rejects.toThrow(/each grocery/);
	await expect(action.normalize({ item: "bananas" }, { profileId: 42 })).rejects.toThrow(/Choose/);
	keep.groceryTarget.mockResolvedValue({ id: "shared-list", title: "Groceries", items: [
		{ text: "Apples", checked: true }, { text: "apples ", checked: true },
	] });
	expect(await action.normalize({ operation: "add", item: "apples" }, { profileId: 42 })).toMatchObject({ item: "Apples", operation: "add" });
	keep.groceryTarget.mockResolvedValue({ id: "shared-list", title: "Groceries", items: [
		{ text: "Apples", checked: true }, { text: "apples ", checked: false },
	] });
	await expect(action.normalize({ operation: "add", item: "apples" }, { profileId: 42 })).rejects.toThrow(/already on/);
	expect(await action.normalize({ operation: "bought", item: "apples" }, { profileId: 42 })).toMatchObject({ operation: "bought" });
	keep.groceryTarget.mockResolvedValue({ id: "shared-list", title: "Groceries", items: [
		{ text: "Apples", checked: false }, { text: "apples ", checked: false },
	] });
	await expect(action.normalize({ operation: "bought", item: "apples" }, { profileId: 42 })).rejects.toThrow(/more than one open/);
});
