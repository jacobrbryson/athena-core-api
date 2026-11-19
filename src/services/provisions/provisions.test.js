jest.mock("../../helpers/db", () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock("../llm", () => ({ generateJson: jest.fn(), image: jest.fn() }));
jest.mock("../connectors/googleKeep", () => ({
	itemKey: (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim(),
	groceries: jest.fn(),
	listLists: jest.fn(),
}));

const p = require("./index");

const DAY = 86400_000;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const at = (daysAgo) => new Date(NOW - daysAgo * DAY);

describe("provisions: usual stock", () => {
	test("sorts regulars into kinds, keeps household apart, and leaves out what's needed", () => {
		const stock = p.usualStock([{ toBuy: ["Oatmeal"], usuallyBuys: ["Chicken", "Hot dogs", "Tomatoes with chiles", "Fruit snacks", "Waffles", "Milk", "Oatmeal", "Dog food", "Paper towels", "2 S", "Bananas"] }]);
		expect(stock.kinds.proteins).toEqual(["Chicken", "Hot dogs"]);
		expect(stock.kinds.canned).toEqual(["Tomatoes with chiles"]);
		expect(stock.kinds.snacks).toEqual(["Fruit snacks"]);
		expect(stock.kinds.frozen).toEqual(["Waffles"]);
		expect(stock.kinds.household).toEqual(["Dog food", "Paper towels"]);
		expect(stock.items).not.toContain("Oatmeal");
		expect(stock.items).not.toContain("2 S");
		expect(stock.total).toBe(7);
		expect(stock.household).toBe(2);
	});
});

describe("provisions: restock", () => {
	const list = [{ toBuy: ["Milk"], usuallyBuys: ["Bananas", "Syrup", "Chicken", "Milk", "Waffles"] }];
	const bought = (text, daysAgo) => ({ item_key: text.toLowerCase(), item_text: text, event: "bought", observed_at: at(daysAgo) });

	test("predicts from the median gap and skips what's already on the list", () => {
		const out = p.restock([bought("Bananas", 13), bought("Bananas", 6), bought("Syrup", 20), bought("Syrup", 12), bought("Syrup", 4), bought("Milk", 10), bought("Milk", 2)], list, NOW);
		expect(out.map((r) => r.item)).toEqual(["Bananas", "Syrup"]);
		expect(out[0]).toMatchObject({ everyDays: 7, daysLeft: 1, buys: 2 });
		expect(out[1]).toMatchObject({ everyDays: 8, daysLeft: 4, buys: 3 });
	});

	test("needs two separate shops, and drops items long past their usual gap", () => {
		const out = p.restock([bought("Waffles", 3), bought("Waffles", 2.8), bought("Chicken", 40), bought("Chicken", 34)], list, NOW);
		expect(out).toEqual([]);
	});
});

describe("provisions: preferences and favourites", () => {
	const prefs = p.parsePreferences([
		{ uuid: "a", memory_key: "food: Thomas", memory_value: "Loves tacos, pizza; avoids mushrooms" },
		{ uuid: "b", memory_key: "food: Skylar", memory_value: "Likes pasta and salmon" },
		{ uuid: "c", memory_key: "coffee order", memory_value: "Loves oat flat white" },
	]);

	test("reads only food memories", () => {
		expect(prefs).toEqual([
			{ uuid: "a", name: "Thomas", loves: ["tacos", "pizza"], avoids: ["mushrooms"] },
			{ uuid: "b", name: "Skylar", loves: ["pasta", "salmon"], avoids: [] },
		]);
	});

	test("a favourite needs the model's name AND a matching love", () => {
		const idea = { title: "Ground Beef Tacos", ingredients: ["ground beef", "tortillas"] };
		expect(p.lovedBy(idea, ["Thomas", "Skylar"], prefs)).toEqual(["Thomas"]);
		expect(p.lovedBy(idea, ["Skylar"], prefs)).toEqual([]);
	});

	test("present() works out stock, tags and avoiders in code", () => {
		const stock = p.wordSet(["Chicken", "Rice", "Soy sauce", "Mushrooms"]);
		const idea = p.present({ uuid: "u", title: "Chicken Stir-Fry", meal: "dinner", minutes: 25, ingredients: ["chicken", "rice", "soy sauce", "mushrooms", "salt", "broccoli"], loved_by: [], saved: 0 }, stock, prefs);
		expect(idea.have).toEqual(["chicken", "rice", "soy sauce", "mushrooms", "salt"]);
		expect(idea.missing).toEqual(["broccoli"]);
		expect(idea.tags).toEqual({ quick: true, usesPantry: true, favorite: false });
		expect(idea.avoidedBy).toEqual(["Thomas"]);
		expect(idea.imageUrl).toBe("/api/v1/provisions/ideas/u/image");
	});
});

describe("provisions: ideas from the model are checked", () => {
	test("checkIdeas wants enough usable ideas", () => {
		expect(p.checkIdeas({ ideas: [] })).not.toBe(true);
		const good = { title: "Tacos", meal: "dinner", ingredients: ["beef", "tortillas"] };
		expect(p.checkIdeas({ ideas: Array(6).fill(good) })).toBe(true);
		expect(p.checkIdeas({ ideas: Array(6).fill({ ...good, meal: "brunch" }) })).not.toBe(true);
	});

	test("cleanIdea bounds every field", () => {
		expect(p.cleanIdea({ title: "  Pantry   Chili ", meal: "dinner", minutes: 900, ingredients: ["Beans", "beans", "Ground Beef"], loved_by: ["Thomas"] }))
			.toEqual({ title: "Pantry Chili", slug: "pantry chili", meal: "dinner", minutes: 240, ingredients: ["beans", "ground beef"], lovedBy: ["Thomas"], blurb: null });
		expect(p.cleanIdea({ title: "x", meal: "dinner", ingredients: ["one"] })).toBeNull();
	});

	test("the picture prompt carries the dish name and nothing else", () => {
		const prompt = p.imagePrompt("Ground Beef Tacos");
		expect(prompt).toContain("Ground Beef Tacos");
		expect(prompt).toMatch(/no people/);
	});
});

describe("provisions: coverage and insights", () => {
	test("coverage counts ideas cookable from what's in", () => {
		const ideas = [
			{ meal: "dinner", tags: { usesPantry: true } },
			{ meal: "dinner", tags: { usesPantry: false } },
			{ meal: "snack", tags: { usesPantry: true } },
		];
		expect(p.coverage(ideas)).toEqual([
			{ meal: "dinner", ideas: 2, ready: 1 },
			{ meal: "lunch", ideas: 0, ready: 0 },
			{ meal: "breakfast", ideas: 0, ready: 0 },
			{ meal: "snack", ideas: 1, ready: 1 },
		]);
	});

	test("insights count purchases and shared ingredients", () => {
		const ev = (t, d) => ({ item_text: t, event: "bought", observed_at: at(d) });
		const out = p.insights([ev("Apples", 2), ev("Apples", 12), ev("Milk", 5)], [{ have: ["rice", "chicken"] }, { have: ["rice"] }], NOW);
		expect(out.map((i) => i.title)).toEqual(["3 items bought in 30 days", "Most rebought", "1 ingredient you have goes into several meals"]);
	});
});
