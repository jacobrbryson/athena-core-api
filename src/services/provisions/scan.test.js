const mockConn = { beginTransaction: jest.fn(), query: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() };
jest.mock("../../helpers/db", () => ({ query: jest.fn(), getConnection: jest.fn(async () => mockConn) }));
jest.mock("../llm", () => ({ generateJson: jest.fn(), image: jest.fn() }));
jest.mock("../connectors/googleKeep", () => ({ itemKey: (t) => String(t || "").toLowerCase().trim(), groceries: jest.fn(), listLists: jest.fn() }));

const llm = require("../llm");
const scan = require("./scan");
const p = require("./index");

const DAY = 86400_000;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const photo = { imageBase64: "x".repeat(200), mimeType: "image/jpeg" };

beforeEach(() => jest.clearAllMocks());

describe("photo inventory: input", () => {
	test("needs a known place and 1-6 sane photos", () => {
		expect(() => scan.validate({ place: "garage", photos: [photo] })).toThrow(/Choose where/);
		expect(() => scan.validate({ place: "fridge", photos: [] })).toThrow(/at least one/);
		expect(() => scan.validate({ place: "fridge", photos: Array(7).fill(photo) })).toThrow(/Up to 6/);
		expect(() => scan.validate({ place: "fridge", photos: [{ ...photo, mimeType: "image/gif" }] })).toThrow(/JPEG/);
		expect(scan.validate({ place: "fridge", photos: [photo] })).toMatchObject({ place: "fridge", replace: true });
	});

	test("the prompt asks for food only and to ignore people", () => {
		expect(scan.prompt("fridge")).toMatch(/Ignore people, pets/);
	});
});

describe("photo inventory: reading", () => {
	test("merges photos of one place by name, bounds fields, and drops nonsense", () => {
		const items = scan.cleanItems([
			[{ name: "eggs", amount: "1 dozen", kind: "dairy" }, { name: "Milk", amount: "", kind: "dairy" }, { name: " ", kind: "dairy" }],
			[{ name: "Eggs", amount: "6", kind: "dairy" }, { name: "milk", amount: "half full", kind: "dairy" }, { name: "Mystery", kind: "spaceship" }],
		]);
		expect(items).toEqual([
			{ name: "Eggs", kind: "dairy", amount: "1 dozen" },
			{ name: "Milk", kind: "dairy", amount: "half full" },
			{ name: "Mystery", kind: "other", amount: null },
		]);
	});

	test("scan replaces the place's earlier items and stores only names", async () => {
		llm.generateJson.mockResolvedValueOnce({ data: { items: [{ name: "eggs", amount: "1 dozen", kind: "dairy" }] } })
			.mockResolvedValueOnce({ data: { items: [{ name: "spinach", amount: "1 bag", kind: "produce" }] } });
		const out = await scan.scan(7, { place: "fridge", photos: [photo, photo] }, new Date(NOW));
		expect(llm.generateJson).toHaveBeenCalledTimes(2);
		expect(llm.generateJson.mock.calls[0][0].task).toBe("vision");
		expect(mockConn.query.mock.calls[0]).toEqual(["DELETE FROM athena_pantry_item WHERE profile_id = ? AND place = ?", [7, "fridge"]]);
		const inserted = mockConn.query.mock.calls[1][1][0];
		expect(inserted.map((r) => r.slice(2, 6))).toEqual([["fridge", "Eggs", "dairy", "1 dozen"], ["fridge", "Spinach", "produce", "1 bag"]]);
		expect(JSON.stringify(mockConn.query.mock.calls)).not.toContain(photo.imageBase64);
		expect(mockConn.commit).toHaveBeenCalled();
		expect(out.items.map((i) => i.name)).toEqual(["Eggs", "Spinach"]);
	});

	test("replace: false adds to what's there", async () => {
		llm.generateJson.mockResolvedValueOnce({ data: { items: [{ name: "rice", kind: "grains" }] } });
		await scan.scan(7, { place: "pantry", photos: [photo], replace: false }, new Date(NOW));
		expect(mockConn.query.mock.calls[0][0]).toMatch(/^INSERT/);
	});
});

describe("photo inventory: freshness and use", () => {
	const row = (place, name, kind, daysAgo) => ({ uuid: `${place}-${name}`, place, name, kind, amount: null, seen_at: new Date(NOW - daysAgo * DAY) });

	test("a fridge goes stale in days, a pantry in weeks", () => {
		const g = scan.group([row("fridge", "Milk", "dairy", 12), row("pantry", "Rice", "grains", 12), row("counter", "Bananas", "produce", 1)], NOW);
		expect(g.places.map((x) => [x.place, x.fresh])).toEqual([["pantry", true], ["fridge", false], ["counter", true]]);
		expect(g.fresh.map((i) => i.name)).toEqual(["Rice", "Bananas"]);
	});

	test("seen items join the stock and lead their kind", () => {
		const stock = p.usualStock([{ toBuy: [], usuallyBuys: ["Milk", "Rice"] }]);
		const merged = p.withSeen(stock, [{ name: "Spinach", kind: "produce", place: "fridge" }, { name: "milk", kind: "dairy", place: "fridge" }]);
		expect(merged.total).toBe(3);
		expect(merged.kinds.produce).toEqual(["Spinach"]);
		expect(merged.kinds.dairy).toEqual(["milk"]);
		expect(merged.seen).toBe(2);
	});

	test("an item a photo shows isn't running low", () => {
		const due = p.markSeen([{ item: "Bananas", daysLeft: 0 }, { item: "Syrup", daysLeft: 1 }], [{ name: "banana", place: "counter" }]);
		expect(due).toEqual([{ item: "Bananas", daysLeft: 0, seenIn: "counter" }, { item: "Syrup", daysLeft: 1 }]);
	});

	test("perishables seen in the fridge become a use-soon insight", () => {
		const out = p.insights([], [], NOW, [{ name: "Spinach", kind: "produce", place: "fridge" }, { name: "Rice", kind: "grains", place: "pantry" }]);
		expect(out[0]).toEqual({ tone: "tip", title: "Use soon: 1 fresh item in the kitchen", detail: "Spinach" });
	});
});
