/**
 * Push delivery: who is reachable, and what happens when a handset isn't.
 *
 * The cases that matter are the failures. A push layer that delivers is
 * unremarkable; one that quietly unsubscribes people, or that lets a dead
 * phone fail the pass that was trying to reach five others, is the reason
 * notification features get turned off and never turned back on.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../helpers/crypto", () => ({ encrypt: jest.fn(), decrypt: jest.fn() }));
jest.mock("./fcm", () => ({
	send: jest.fn(),
	isConfigured: jest.fn(),
	DEAD_REGISTRATION: new Set(["UNREGISTERED", "INVALID_ARGUMENT", "SENDER_ID_MISMATCH", "NOT_FOUND"]),
}));

const pool = require("../../helpers/db");
const crypto = require("../../helpers/crypto");
const fcm = require("./fcm");
const push = require("./index");

const PROFILE = 42;

/** A registered, pushable device row as reachableDevices selects it. */
function deviceRow(over = {}) {
	return {
		id: 7,
		uuid: "dev-1",
		name: "Pixel",
		platform: "android",
		push_provider: "fcm",
		push_token_enc: "enc:token",
		...over,
	};
}

/** Route by SQL text so each test states only the rows it cares about. */
function db({ devices = [deviceRow()], pushEnabled = 1 } = {}) {
	pool.query.mockImplementation(async (sql) => {
		if (sql.includes("push_enabled")) return [[{ push_enabled: pushEnabled }]];
		if (sql.includes("FROM paired_device")) return [devices];
		return [[], { affectedRows: 1 }];
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	pool.query.mockResolvedValue([[], {}]);
	crypto.encrypt.mockImplementation(async (s) => `enc:${s}`);
	crypto.decrypt.mockImplementation(async (s) => String(s).replace(/^enc:/, ""));
	fcm.send.mockResolvedValue({ ok: true });
	fcm.isConfigured.mockResolvedValue(true);
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("registration", () => {
	test("a token is encrypted before it is stored", async () => {
		await push.registerToken(7, "a".repeat(140));
		expect(crypto.encrypt).toHaveBeenCalledWith("a".repeat(140));
		const [sql, params] = pool.query.mock.calls[0];
		expect(sql).toContain("push_token_enc");
		// The plaintext registration must never reach the database.
		expect(params).not.toContain("a".repeat(140));
	});

	test("registering clears any previous failure state", async () => {
		await push.registerToken(7, "a".repeat(140));
		const [sql] = pool.query.mock.calls[0];
		expect(sql).toContain("push_failures = 0");
		expect(sql).toContain("push_failed_at = NULL");
	});

	test("a revoked device cannot re-register", async () => {
		await push.registerToken(7, "a".repeat(140));
		expect(pool.query.mock.calls[0][0]).toContain("revoked_at IS NULL");
	});

	test("an implausible token is refused", async () => {
		await expect(push.registerToken(7, "short")).rejects.toMatchObject({ code: "bad_token" });
		await expect(push.registerToken(7, null)).rejects.toMatchObject({ code: "bad_token" });
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("an unknown provider is refused", async () => {
		await expect(
			push.registerToken(7, "a".repeat(140), { provider: "carrier-pigeon" })
		).rejects.toMatchObject({ code: "bad_provider" });
	});
});

describe("who is reachable", () => {
	test("nothing is sent without the push opt-in", async () => {
		db({ pushEnabled: 0 });
		const out = await push.sendToProfile(PROFILE, { title: "Athena", body: "hi" });
		expect(out).toMatchObject({ sent: 0, skipped: "not enabled" });
		expect(fcm.send).not.toHaveBeenCalled();
	});

	test("a web pairing is skipped — it pairs but has no transport", async () => {
		db({ devices: [deviceRow({ platform: "web" })] });
		const out = await push.sendToProfile(PROFILE, { title: "Athena", body: "hi" });
		expect(out.sent).toBe(0);
		expect(fcm.send).not.toHaveBeenCalled();
	});

	test("a car counts as a phone for this purpose", async () => {
		db({ devices: [deviceRow({ platform: "car" })] });
		await push.sendToProfile(PROFILE, { title: "Athena", body: "hi" });
		expect(fcm.send).toHaveBeenCalledTimes(1);
	});

	test("an unreadable registration costs that device only", async () => {
		db({ devices: [deviceRow({ id: 1 }), deviceRow({ id: 2, push_token_enc: "enc:good" })] });
		crypto.decrypt.mockImplementation(async (v) => {
			if (v === "enc:token") throw new Error("no key on the ring");
			return "good";
		});
		const out = await push.sendToProfile(PROFILE, { title: "Athena", body: "hi" });
		expect(out.sent).toBe(1);
	});
});

describe("failure handling", () => {
	test("a dead registration is cleared, once", async () => {
		db();
		fcm.send.mockResolvedValue({ ok: false, dead: true, reason: "UNREGISTERED" });
		const out = await push.sendToProfile(PROFILE, { title: "Athena", body: "hi" });
		expect(out).toMatchObject({ sent: 0, failed: 1 });
		const cleared = pool.query.mock.calls.find(
			(c) => c[0].includes("push_token_enc = NULL") && c[0].includes("push_failed_at = NOW()")
		);
		expect(cleared).toBeTruthy();
	});

	test("a TRANSIENT failure never clears the registration", async () => {
		// The bug this exists to prevent silently unsubscribes someone from
		// notifications they asked for, with nothing in the UI to explain it.
		db();
		fcm.send.mockResolvedValue({ ok: false, dead: false, reason: "UNAVAILABLE" });
		await push.sendToProfile(PROFILE, { title: "Athena", body: "hi" });
		const cleared = pool.query.mock.calls.find((c) => c[0].includes("push_token_enc = NULL"));
		expect(cleared).toBeUndefined();
		const counted = pool.query.mock.calls.find((c) => c[0].includes("push_failures = push_failures + 1"));
		expect(counted).toBeTruthy();
	});

	test("one dead handset does not stop the others being reached", async () => {
		db({ devices: [deviceRow({ id: 1 }), deviceRow({ id: 2 }), deviceRow({ id: 3 })] });
		fcm.send
			.mockResolvedValueOnce({ ok: false, dead: true, reason: "UNREGISTERED" })
			.mockResolvedValue({ ok: true });
		const out = await push.sendToProfile(PROFILE, { title: "Athena", body: "hi" });
		expect(out).toMatchObject({ sent: 2, failed: 1, devices: 3 });
	});

	test("an unconfigured server is a quiet no-op, not an error", async () => {
		db();
		fcm.send.mockResolvedValue({ ok: false, dead: false, reason: "not_configured" });
		await expect(push.sendToProfile(PROFILE, { title: "A", body: "b" })).resolves.toMatchObject({
			sent: 0,
		});
	});
});

describe("delivering a nudge", () => {
	const nudge = { uuid: "n1", trigger_id: "calendar_next_up", text: "Standup in fifteen." };

	test("the notification body is the nudge itself, not a teaser", async () => {
		db();
		await push.deliverNudge(PROFILE, nudge);
		// A "you have a new message" teaser would force the person to open the
		// app to learn whether it mattered, which is the entire value gone.
		expect(fcm.send).toHaveBeenCalledWith(
			"token",
			expect.objectContaining({ body: "Standup in fifteen." })
		);
	});

	test("nudges collapse, so the budget cannot be undone by stacking", async () => {
		db();
		await push.deliverNudge(PROFILE, nudge);
		expect(fcm.send.mock.calls[0][1].collapseKey).toBe("athena-nudge");
	});

	test("pushed_at is set only when a transport accepted it", async () => {
		db();
		await push.deliverNudge(PROFILE, nudge);
		expect(
			pool.query.mock.calls.some((c) => c[0].includes("SET pushed_at = NOW()"))
		).toBe(true);
	});

	test("a failed push leaves pushed_at alone", async () => {
		db();
		fcm.send.mockResolvedValue({ ok: false, dead: false, reason: "UNAVAILABLE" });
		await push.deliverNudge(PROFILE, nudge);
		expect(
			pool.query.mock.calls.some((c) => c[0].includes("SET pushed_at = NOW()"))
		).toBe(false);
	});

	test("the uuid rides along so a tap can open the right thing", async () => {
		db();
		await push.deliverNudge(PROFILE, nudge);
		expect(fcm.send.mock.calls[0][1].data).toMatchObject({ kind: "nudge", uuid: "n1" });
	});
});
