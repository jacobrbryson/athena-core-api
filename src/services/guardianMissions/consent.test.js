const pool = require("../../helpers/db");
const consent = require("./consent");

jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../helpers/crypto", () => ({ encrypt: jest.fn(), decrypt: jest.fn() }));

const terms = { adult: { id: 1, audience: "adult", body_sha256: "a" }, parent_for_child: { id: 2, audience: "parent_for_child", body_sha256: "p" }, child: { id: 3, audience: "child", body_sha256: "c" } };
const parent = { id: 2, kind: "parent", family_id: 1, display_name: "Ross" };
const kid = { id: 3, kind: "kid", family_id: 1, display_name: "Thomas" };
const otherParent = { id: 6, kind: "parent", family_id: 2, display_name: "Jenny" };
const yes = (role, terms_id) => ({ role, action: "agree", terms_id });
const no = (role, terms_id) => ({ role, action: "withdraw", terms_id });

function answer({ events = [], termRows = Object.values(terms) } = {}) {
	pool.query.mockImplementation(async (sql) => {
		if (/athena_gm_consent_terms t/.test(sql)) return [termRows];
		if (/SELECT role, action, terms_id/.test(sql)) return [events];
		return [{ affectedRows: 1 }];
	});
}
const sql = (pattern) => pool.query.mock.calls.filter(([q]) => pattern.test(q));

beforeEach(() => {
	pool.query.mockReset();
	delete process.env.GM_CONSENT_ENFORCED;
});

describe("standing", () => {
	test("an adult with no record is not in", () => {
		expect(consent.standing({ kind: "parent", terms })).toMatchObject({ allowed: false, status: "needs_agreement", missing: ["self"] });
	});

	test("a kid needs a parent and themselves", () => {
		expect(consent.standing({ kind: "kid", terms, events: [yes("parent", 2)] })).toMatchObject({ allowed: false, missing: ["self"] });
		expect(consent.standing({ kind: "kid", terms, events: [yes("self", 3)] })).toMatchObject({ allowed: false, missing: ["parent"] });
		expect(consent.standing({ kind: "kid", terms, events: [yes("parent", 2), yes("self", 3)] })).toMatchObject({ allowed: true, status: "agreed" });
	});

	test("either side leaving ends a kid's standing", () => {
		const both = [yes("parent", 2), yes("self", 3)];
		expect(consent.standing({ kind: "kid", terms, events: [...both, no("self", 3)] })).toMatchObject({ allowed: false, status: "withdrawn" });
		expect(consent.standing({ kind: "kid", terms, events: [...both, no("parent", 2)] })).toMatchObject({ allowed: false, status: "withdrawn" });
	});

	test("new terms need a new agreement", () => {
		const newer = { ...terms, adult: { id: 9 } };
		expect(consent.standing({ kind: "parent", terms: newer, events: [yes("self", 1)] })).toMatchObject({ allowed: false, status: "needs_new_agreement" });
	});

	test("no published terms means no agreement", () => {
		expect(consent.standing({ kind: "parent", terms: {}, events: [yes("self", 1)] }).allowed).toBe(false);
	});
});

describe("who may decide", () => {
	test("yourself, or your own family's child", () => {
		expect(consent.roleFor(parent, parent)).toBe("self");
		expect(consent.roleFor(parent, kid)).toBe("parent");
	});

	test("never another family's child, another adult, or a parent by a kid", () => {
		expect(() => consent.roleFor(otherParent, kid)).toThrow();
		expect(() => consent.roleFor(parent, { ...parent, id: 99 })).toThrow();
		expect(() => consent.roleFor(kid, parent)).toThrow();
	});
});

describe("recording", () => {
	test("stores which words, by id and hash", async () => {
		answer();
		await consent.agree({ subject: parent, decider: parent, termsId: 1, method: "app_prompt" });
		const [[, params]] = sql(/INSERT INTO athena_gm_consent_event/);
		expect(params.slice(1, 9)).toEqual([1, 2, 2, "self", "agree", 1, "a", "app_prompt"]);
	});

	test("refuses when the words shown are no longer current", async () => {
		answer();
		await expect(consent.agree({ subject: parent, decider: parent, termsId: 77, method: "app_prompt" })).rejects.toMatchObject({ status: 409 });
		expect(sql(/INSERT INTO athena_gm_consent_event/)).toHaveLength(0);
	});

	test("leaving cancels what's waiting and deletes the voiceprint", async () => {
		answer();
		await consent.withdraw({ subject: kid, decider: kid, method: "guardians_app" });
		expect(sql(/INSERT INTO athena_gm_consent_event/)[0][1][5]).toBe("withdraw");
		expect(sql(/UPDATE athena_gm_mission_step SET status = 'declined'/)).toHaveLength(1);
		expect(sql(/DELETE FROM athena_gm_voiceprint/)).toHaveLength(1);
	});
});

describe("failing closed", () => {
	test("a database failure is no agreement", async () => {
		pool.query.mockRejectedValue(new Error("down"));
		expect(await consent.standingFor(parent)).toMatchObject({ allowed: false });
	});

	test("chat is untouched until the switch is on", async () => {
		expect(await consent.chatMayProceed({ guardianId: "20250701" })).toEqual({ allowed: true });
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("with the switch on, a login with no record gets the fixed reply", async () => {
		process.env.GM_CONSENT_ENFORCED = "on";
		pool.query.mockResolvedValue([[]]);
		expect(await consent.chatMayProceed({ guardianId: "20250701" })).toEqual({ allowed: false, reply: consent.FIXED_REPLY });
	});

	test("with the switch on, adults outside the Guardians are unaffected", async () => {
		process.env.GM_CONSENT_ENFORCED = "on";
		pool.query.mockResolvedValue([[]]);
		expect(await consent.chatMayProceed({ profileId: 44 })).toEqual({ allowed: true });
	});

	test("with the switch on, a database failure refuses a Guardian", async () => {
		process.env.GM_CONSENT_ENFORCED = "on";
		pool.query.mockRejectedValue(new Error("down"));
		expect((await consent.chatMayProceed({ guardianId: "20250701" })).allowed).toBe(false);
	});
});
