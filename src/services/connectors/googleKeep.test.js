jest.mock("../credentials", () => ({ get: jest.fn(), markNeedsReauth: jest.fn() }));
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));

const pool = require("../../helpers/db");
const keep = require("./googleKeep");

beforeEach(() => pool.query.mockReset());

const ts = (updated, extra = {}) => ({ kind: "notes#timestamps", created: "2026-10-01T00:00:00.000Z", updated, trashed: "1970-01-01T00:00:00.000Z", ...extra });

describe("googleKeep", () => {
	it("is pulled in by dinner and grocery questions, not by everything", () => {
		expect(keep.matches("We're wiped. What should we make for dinner?")).toBe(true);
		expect(keep.matches("what's on the grocery list")).toBe(true);
		expect(keep.matches("any ideas, we have no ingredients")).toBe(true);
		expect(keep.matches("how did I sleep last night")).toBe(false);
		expect(keep.matches("keep me posted")).toBe(false);
	});

	it("turns raw Keep nodes into live lists with their items", () => {
		const lists = keep.toLists([
			{ id: "L1", type: "LIST", title: "Groceries", timestamps: ts("2026-10-18T12:00:00.000Z") },
			{ id: "a", type: "LIST_ITEM", parentId: "L1", text: "eggs", checked: true, sortValue: "3", timestamps: ts("2026-10-15T10:00:00.000Z") },
			{ id: "b", type: "LIST_ITEM", parentId: "L1", text: "gochujang", checked: false, sortValue: "2", timestamps: ts("2026-10-17T10:00:00.000Z") },
			{ id: "c", type: "LIST_ITEM", parentId: "L1", text: "trashed thing", timestamps: ts("2026-10-17T10:00:00.000Z", { trashed: "2026-10-17T11:00:00.000Z" }) },
			{ id: "L2", type: "LIST", title: "Old", isArchived: true, timestamps: ts("2026-01-01T00:00:00.000Z") },
			{ id: "N1", type: "NOTE", title: "a note", timestamps: ts("2026-10-18T00:00:00.000Z") },
		]);
		expect(lists).toEqual([
			{
				id: "L1",
				title: "Groceries",
				updated: "2026-10-18T12:00:00.000Z",
				items: [
					{ text: "eggs", checked: true, updated: "2026-10-15T10:00:00.000Z" },
					{ text: "gochujang", checked: false, updated: "2026-10-17T10:00:00.000Z" },
				],
			},
		]);
	});

	it("derives the same Android id as the Python link helper", () => {
		// keep_helper.py: sha256(email.lower()).hexdigest()[:16]
		expect(keep.androidIdFor("Athena@Example.com")).toBe(keep.androidIdFor("athena@example.com"));
		expect(keep.androidIdFor("athena@example.com")).toMatch(/^[0-9a-f]{16}$/);
	});

	it("tells her what's needed versus bought lately (as observed), and keeps other lists out", () => {
		const now = Date.parse("2026-10-18T18:00:00.000Z");
		const day = (n) => new Date(now - n * 86400_000);
		const ev = (item_key, event, n, list_id = "G") => ({ list_id, item_key, item_text: item_key, event, observed_at: day(n) });
		const summary = keep.foodSummary(
			[
				{ id: "G", title: "Groceries", items: [
					{ text: "rice", checked: false, updated: null },
					{ text: "Chicken  Thighs", checked: true, updated: null },
					{ text: "milk", checked: true, updated: null },
					{ text: "ancient flour", checked: true, updated: null },
				] },
				{ id: "X", title: "Christmas gifts", items: [{ text: "a secret present", checked: false, updated: null }] },
			],
			now,
			[
				ev("rice", "bought", 5), // bought, then needed again: not at home
				ev("milk", "bought", 3),
				ev("chicken thighs", "bought", 2),
				ev("rice", "needed", 1),
				ev("ancient flour", "bought", 40), // outside the window
			]
		);
		expect(summary).toEqual({
			lists: [{
				title: "Groceries",
				toBuy: ["rice"],
				recentlyBought: [
					{ text: "Chicken  Thighs", day: "2026-10-16" },
					{ text: "milk", day: "2026-10-15" },
				],
				usuallyBuys: ["Chicken  Thighs", "milk", "ancient flour"],
			}],
			otherTitles: ["Christmas gifts"],
		});
		const block = keep.formatBlock(summary);
		expect(block).toContain("Still to buy (they're OUT of these): rice");
		expect(block).toContain("Bought in the last 14 days (observed");
		expect(block).toContain("when you noticed it ticked off on the list, not when they shopped");
		expect(block).toContain("Chicken  Thighs (noticed 2026-10-16); milk (noticed 2026-10-15)");
		expect(block).not.toContain("a secret present");
	});

	describe("purchase history", () => {
		const list = (items, extra = {}) => ({ id: "G", title: "Groceries", updated: null, items: items.map(([text, checked]) => ({ text, checked, updated: null })), ...extra });
		const at = new Date("2026-10-18T20:00:00.000Z");
		const prevAt = new Date("2026-10-17T03:00:00.000Z");

		it("keys items by normalized text, ticked only when every copy is", () => {
			expect(keep.itemKey("  Greek   Yogurt ")).toBe("greek yogurt");
			expect(keep.stateOf(list([["Eggs", true], ["eggs ", false], ["Milk", true]]))).toEqual({
				eggs: { t: "Eggs", c: 0 },
				milk: { t: "Milk", c: 1 },
			});
		});

		it("diffs ticks as bought and unticks (or new unticked items) as needed", () => {
			const before = { eggs: { t: "eggs", c: 0 }, milk: { t: "milk", c: 1 }, rice: { t: "rice", c: 1 }, gone: { t: "gone", c: 0 } };
			const after = { eggs: { t: "Eggs", c: 1 }, milk: { t: "milk", c: 0 }, rice: { t: "rice", c: 1 }, kimchi: { t: "kimchi", c: 0 }, salt: { t: "salt", c: 1 } };
			expect(keep.diffItems(before, after)).toEqual([
				{ key: "eggs", text: "Eggs", event: "bought" },
				{ key: "milk", text: "milk", event: "needed" },
				{ key: "kimchi", text: "kimchi", event: "needed" },
			]);
		});

		it("records nothing on the first read, only the baseline", async () => {
			pool.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([{ affectedRows: 1 }]);
			expect(await keep.observe(1, [list([["eggs", true]]), list([["socks", false]], { id: "X", title: "Packing" })], at)).toBe(0);
			expect(pool.query).toHaveBeenCalledTimes(2);
			const [sql, params] = pool.query.mock.calls[1];
			expect(sql).toMatch(/INSERT IGNORE INTO athena_keep_snapshot/);
			expect(params).toEqual([1, "G", JSON.stringify({ eggs: { t: "eggs", c: 1 } }), at]);
			// Non-food lists are never read into the history.
			expect(JSON.stringify(pool.query.mock.calls)).not.toContain("socks");
		});

		it("records a tick as bought at the time she noticed, after moving the snapshot on", async () => {
			const before = { eggs: { t: "eggs", c: 0 }, milk: { t: "milk", c: 1 } };
			pool.query
				.mockResolvedValueOnce([[{ items: JSON.stringify(before), taken_at: prevAt }]])
				.mockResolvedValueOnce([{ affectedRows: 1 }])
				.mockResolvedValueOnce([{ affectedRows: 1 }]);
			expect(await keep.observe(1, [list([["eggs", true], ["milk", true]])], at)).toBe(1);
			const [updateSql, updateParams] = pool.query.mock.calls[1];
			expect(updateSql).toMatch(/UPDATE athena_keep_snapshot .* AND taken_at = \?/);
			expect(updateParams[4]).toBe(prevAt);
			const [insertSql, [rows]] = pool.query.mock.calls[2];
			expect(insertSql).toMatch(/INSERT INTO athena_keep_item_event/);
			expect(rows).toEqual([[1, "G", "eggs", "eggs", "bought", at]]);
		});

		it("writes no events when another read already moved the snapshot on", async () => {
			pool.query
				.mockResolvedValueOnce([[{ items: { eggs: { t: "eggs", c: 0 } }, taken_at: prevAt }]])
				.mockResolvedValueOnce([{ affectedRows: 0 }]);
			expect(await keep.observe(1, [list([["eggs", true]])], at)).toBe(0);
			expect(pool.query).toHaveBeenCalledTimes(2);
		});

		it("leaves the snapshot alone when nothing changed", async () => {
			pool.query.mockResolvedValueOnce([[{ items: JSON.stringify({ eggs: { t: "eggs", c: 1 } }), taken_at: prevAt }]]);
			expect(await keep.observe(1, [list([["eggs", true]])], at)).toBe(0);
			expect(pool.query).toHaveBeenCalledTimes(1);
		});

		it("skips the nightly read quietly until the migration is applied", async () => {
			pool.query.mockRejectedValueOnce(Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE" }));
			expect(await keep.observeEveryone()).toEqual({ profiles: 0, skipped: "migration 0081 not applied" });
		});
	});

	it("treats Keep's 1970 item stamps as unknown and shows ticked items as regulars", () => {
		// What a real 2018 list returned on 2026-10-18: every item stamped 1970.
		const placeholder = ts("1970-01-01T00:00:00.002Z", { created: "1970-01-01T00:00:00.001Z" });
		const lists = keep.toLists([
			{ id: "L", type: "LIST", title: "Groceries", timestamps: ts("2026-10-18T12:14:22.367Z") },
			{ id: "1", type: "LIST_ITEM", parentId: "L", text: "Turkey", checked: false, timestamps: placeholder },
			{ id: "2", type: "LIST_ITEM", parentId: "L", text: "Eggs", checked: true, timestamps: placeholder },
		]);
		expect(lists[0].items.every((i) => i.updated === null)).toBe(true);
		const block = keep.formatBlock(keep.foodSummary(lists));
		expect(block).toContain("Still to buy (they're OUT of these): Turkey");
		expect(block).toMatch(/usually buys .*NOT proof they're in the kitchen now\): Eggs/);
		expect(block).not.toContain("Bought in the last");
	});

	it("says plainly when no grocery list is shared", () => {
		expect(keep.formatBlock({ lists: [], otherTitles: ["Packing"] })).toMatch(/no grocery or shopping list is shared with you \(you can see: Packing\)/);
	});
});
