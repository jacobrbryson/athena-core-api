jest.mock("../helpers/db", () => ({ query: jest.fn() }));
const pool = require("../helpers/db");
const m = require("./relayMessages");

const NOW = new Date("2026-11-25T12:00:00Z");
const TO = "11111111-2222-3333-4444-555555555555";

beforeEach(() => pool.query.mockReset());

describe("relay messages", () => {
	test("bodies keep only letters, digits and single spaces, capped", () => {
		expect(m.cleanBody(" hi  there! <b> ")).toBe("HI THERE B");
		expect(m.cleanBody("!!!")).toBeNull();
		expect(m.cleanBody("x".repeat(80))).toHaveLength(m.MAX_BODY);
		expect(m.cleanBody(42)).toBeNull();
	});

	test("a send needs a client id, a recipient uuid and a recent time", () => {
		expect(m.cleanSend({ id: "abc123", to: TO, body: "sos", at: NOW.toISOString() }, NOW)).toMatchObject({ body: "SOS", to: TO });
		expect(m.cleanSend({ id: "x", to: TO, body: "sos", at: NOW }, NOW)).toBeNull();
		expect(m.cleanSend({ id: "abc123", to: "not-a-uuid", body: "sos", at: NOW }, NOW)).toBeNull();
		expect(m.cleanSend({ id: "abc123", to: TO, body: "sos", at: "2020-01-01" }, NOW)).toBeNull();
		const future = m.cleanSend({ id: "abc123", to: TO, body: "sos", at: "2030-01-01" }, NOW);
		expect(future.tappedAt.getTime()).toBe(NOW.getTime());
	});

	test("names leave as first name and last initial", () => {
		expect(m.shortName("Thomas Bryson")).toBe("Thomas B.");
		expect(m.shortName("Skylar")).toBe("Skylar");
		expect(m.shortName("")).toBe("Someone");
	});

	test("only people with access, other than the sender, receive; the rest are refused", async () => {
		pool.query
			.mockResolvedValueOnce([[{ n: 0 }]])
			.mockResolvedValueOnce([[{ id: 7, uuid: TO }]])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);
		const other = "99999999-2222-3333-4444-555555555555";
		const out = await m.send(3, [
			{ id: "aaa111", to: TO, body: "hi", at: NOW },
			{ id: "bbb222", to: other, body: "hi", at: NOW },
		], NOW);
		expect(out).toEqual({ saved: 1, refused: 1 });
		const insert = pool.query.mock.calls[2];
		expect(insert[0]).toMatch(/INSERT IGNORE INTO athena_relay_message/);
		expect(insert[1][0]).toHaveLength(1);
		expect(insert[1][0][0].slice(1, 5)).toEqual([3, 7, "aaa111", "HI"]);
		// The recipient check excludes the sender.
		expect(pool.query.mock.calls[1][1]).toEqual([[TO, other], 3]);
	});

	test("the daily cap stops a flood", async () => {
		pool.query.mockResolvedValueOnce([[{ n: m.MAX_SENT_PER_DAY }]]).mockResolvedValueOnce([[{ id: 7, uuid: TO }]]);
		const out = await m.send(3, [{ id: "aaa111", to: TO, body: "hi", at: NOW }], NOW);
		expect(out).toEqual({ saved: 0, refused: 1 });
		expect(pool.query).toHaveBeenCalledTimes(2);
	});

	test("only the recipient can mark a message decoded", async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
		expect(await m.decoded(3, TO)).toEqual({ ok: false });
		expect(pool.query.mock.calls[0][1]).toEqual([TO, 3]);
		expect(await m.decoded(3, "bad")).toEqual({ ok: false });
	});
});
