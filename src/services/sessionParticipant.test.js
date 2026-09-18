/**
 * Session membership tests.
 *
 * Authorization by owner-equality was doing real security work: a session uuid
 * on its own admitted nobody. Membership replaces that check, so these are
 * weighted heavily toward the cases where someone must be REFUSED — a passing
 * "the right guardian gets in" test proves very little on its own.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));

const pool = require("../helpers/db");
const participants = require("./sessionParticipant");

const hit = () => [[{ 1: 1 }]];
const miss = () => [[]];

const session = (over = {}) => ({
	id: 7,
	uuid: "sess-abc",
	profile_id: 42,
	family_id: null,
	created_at: "2026-09-18 09:00:00",
	...over,
});

beforeEach(() => pool.query.mockReset());

describe("mayJoin — refusals", () => {
	test("an anonymous session admits nobody, and never asks the database", async () => {
		// No family and no owner means nothing to check a claim against, and the
		// safe answer to 'may this stranger read it?' is no.
		expect(await participants.mayJoin(session({ profile_id: null }), 99)).toBe(false);
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("a caller with no proven profile is refused before any query", async () => {
		// Number(null) is 0 and Number.isFinite(0) is true, so a naive guard turns
		// "nobody proved anything" into "profile 0" and carries it into an access
		// decision. Every falsy shape is checked because they do not behave alike.
		for (const nobody of [null, undefined, "", 0, NaN, "abc"]) {
			expect(await participants.mayJoin(session(), nobody)).toBe(false);
		}
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("a missing session is refused", async () => {
		expect(await participants.mayJoin(null, 99)).toBe(false);
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("somebody in a different family is refused", async () => {
		pool.query.mockResolvedValueOnce(miss()); // not in session.family_id
		pool.query.mockResolvedValueOnce(miss()); // shares no family with the owner
		expect(await participants.mayJoin(session({ family_id: 3 }), 99)).toBe(false);
	});

	test("a child may not join somebody else's conversation", async () => {
		// Enforced in SQL, so the assertion is that the role filter is actually
		// sent — a kid reading their parent's conversation is the failure here.
		pool.query.mockResolvedValue(miss());
		await participants.mayJoin(session({ family_id: 3 }), 99);
		const [sql, params] = pool.query.mock.calls[0];
		expect(sql).toContain("role IN");
		expect(params).toEqual(expect.arrayContaining(["owner", "parent", "guardian"]));
		expect(params).not.toContain("child");
	});

	test("an inactive or removed membership does not count", async () => {
		pool.query.mockResolvedValue(miss());
		await participants.mayJoin(session({ family_id: 3 }), 99);
		const [sql] = pool.query.mock.calls[0];
		expect(sql).toContain("deleted_at IS NULL");
		expect(sql).toContain("status = 'active'");
	});
});

describe("mayJoin — admissions", () => {
	test("an adult in the session's own family is admitted", async () => {
		pool.query.mockResolvedValueOnce(hit());
		expect(await participants.mayJoin(session({ family_id: 3 }), 99)).toBe(true);
		expect(pool.query).toHaveBeenCalledTimes(1);
	});

	test("a session with no family falls back to sharing one with its owner", async () => {
		pool.query.mockResolvedValueOnce(hit());
		expect(await participants.mayJoin(session({ family_id: null }), 99)).toBe(true);
		const [sql] = pool.query.mock.calls[0];
		expect(sql).toContain("JOIN family_members them");
	});

	test("a parent may join a CHILD's session — the owner's role is unconstrained", async () => {
		pool.query.mockResolvedValueOnce(miss()); // caller not a member of that family row
		pool.query.mockResolvedValueOnce(hit()); // but shares a family with the child
		expect(await participants.mayJoin(session({ family_id: 3, profile_id: 5 }), 99)).toBe(
			true
		);
		const [sql] = pool.query.mock.calls[1];
		// The role filter applies to the JOINER (`me`), never to the owner.
		expect(sql).toContain("me.role IN");
		expect(sql).not.toContain("them.role IN");
	});
});

describe("joinSession", () => {
	test("is idempotent — a resume does not open a second span", async () => {
		pool.query.mockResolvedValueOnce(hit()); // isParticipant: already present
		expect(await participants.joinSession(7, 99)).toEqual({ joined: false, present: true });
		expect(pool.query).toHaveBeenCalledTimes(1); // no INSERT
	});

	test("backdates the span when told to", async () => {
		// The decision the whole feature rests on: someone switching accounts was
		// in the room already, so their span starts when the CONVERSATION did.
		pool.query.mockResolvedValueOnce(miss());
		pool.query.mockResolvedValueOnce([{ insertId: 1 }]);
		await participants.joinSession(7, 99, { joinedAt: "2026-09-18 09:00:00" });
		const [sql, params] = pool.query.mock.calls[1];
		expect(sql).toContain("joined_at");
		expect(params).toEqual([7, 99, "joined", "2026-09-18 09:00:00"]);
	});

	test("an invalid profile never reaches the database", async () => {
		for (const nobody of [null, undefined, "", 0, NaN]) {
			expect(await participants.joinSession(7, nobody)).toEqual({ joined: false });
		}
		expect(await participants.joinSession(null, 99)).toEqual({ joined: false });
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("only 'owner' and 'joined' can be written to `via`", async () => {
		pool.query.mockResolvedValueOnce(miss());
		pool.query.mockResolvedValueOnce([{ insertId: 1 }]);
		await participants.joinSession(7, 99, { via: "something-else" });
		expect(pool.query.mock.calls[1][1]).toEqual([7, 99, "joined"]);
	});
});

describe("leaveSession", () => {
	test("closes the span rather than deleting it", async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
		expect(await participants.leaveSession(7, 99)).toEqual({ left: true });
		const [sql] = pool.query.mock.calls[0];
		expect(sql).toContain("SET left_at = NOW()");
		expect(sql).not.toContain("DELETE");
		// Only open spans — closing an already-closed one would move its end.
		expect(sql).toContain("left_at IS NULL");
	});

	test("reports honestly when there was nothing to close", async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
		expect(await participants.leaveSession(7, 99)).toEqual({ left: false });
	});
});

describe("presentParticipants", () => {
	test("returns first names only", async () => {
		pool.query.mockResolvedValueOnce([
			[
				{ profile_id: 42, via: "owner", joined_at: "t0", name: "Jacob Bryson" },
				{ profile_id: 99, via: "joined", joined_at: "t1", name: "Sarah" },
			],
		]);
		expect(await participants.presentParticipants(7)).toEqual([
			{ profileId: 42, via: "owner", joinedAt: "t0", name: "Jacob" },
			{ profileId: 99, via: "joined", joinedAt: "t1", name: "Sarah" },
		]);
	});

	test("a nameless profile yields null, not an invented label", async () => {
		pool.query.mockResolvedValueOnce([
			[{ profile_id: 42, via: "owner", joined_at: "t0", name: null }],
		]);
		expect((await participants.presentParticipants(7))[0].name).toBeNull();
	});

	test("only people who have not left", async () => {
		pool.query.mockResolvedValueOnce([[]]);
		await participants.presentParticipants(7);
		expect(pool.query.mock.calls[0][0]).toContain("sp.left_at IS NULL");
	});
});
