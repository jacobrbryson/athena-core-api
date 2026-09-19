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
jest.mock("./webpush", () => ({
	send: jest.fn(),
	isConfigured: jest.fn(),
	publicKey: jest.fn(),
	// Not mocked away: a malformed subscription must be refused on the way in,
	// and the real shape check is the thing worth exercising.
	parseSubscription: jest.requireActual("./webpush").parseSubscription,
}));

const pool = require("../../helpers/db");
const crypto = require("../../helpers/crypto");
const fcm = require("./fcm");
const webpush = require("./webpush");
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
	webpush.send.mockResolvedValue({ ok: true });
	webpush.isConfigured.mockResolvedValue(true);
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

	test("a browser is reached through web push, not through FCM", async () => {
		db({ devices: [deviceRow({ platform: "web", push_provider: "webpush" })] });
		const out = await push.sendToProfile(PROFILE, { title: "Athena", body: "hi" });

		expect(out.sent).toBe(1);
		expect(webpush.send).toHaveBeenCalledTimes(1);
		expect(fcm.send).not.toHaveBeenCalled();
	});

	test("a registration stored against the wrong transport is skipped, not sent", async () => {
		// Web rows predating the webpush transport carry `fcm`, because that
		// was the only provider. Sending one through FCM can only fail, and
		// the failure would tick the counter and read as a broken handset.
		db({ devices: [deviceRow({ platform: "web", push_provider: "fcm" })] });
		const out = await push.sendToProfile(PROFILE, { title: "Athena", body: "hi" });

		expect(out).toMatchObject({ sent: 0, devices: 0 });
		expect(fcm.send).not.toHaveBeenCalled();
		expect(webpush.send).not.toHaveBeenCalled();
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

	test("two different nudges stack instead of replacing each other", async () => {
		// They used to share one collapse key, which was safe only while the
		// interruption budget guaranteed she spoke at most once every ninety
		// minutes. With the budget gone she can raise two things at once, and
		// a shared key would silently drop the first — putting the invisible
		// loss back in the one place nobody would think to look.
		db();
		await push.deliverNudge(PROFILE, nudge);
		await push.deliverNudge(PROFILE, { ...nudge, uuid: "n-2", text: "and another thing" });

		const first = fcm.send.mock.calls[0][1].collapseKey;
		const second = fcm.send.mock.calls[1][1].collapseKey;
		expect(first).not.toBe(second);
		expect(first).toContain(nudge.uuid);
	});

	test("redelivering the SAME nudge still collapses onto itself", async () => {
		db();
		await push.deliverNudge(PROFILE, nudge);
		await push.deliverNudge(PROFILE, nudge);
		expect(fcm.send.mock.calls[0][1].collapseKey).toBe(fcm.send.mock.calls[1][1].collapseKey);
	});

	test("a collapse key too long for Web Push is trimmed, not rejected", async () => {
		// RFC 8030 caps the Topic header at 32 characters from the URL-safe
		// base64 alphabet, and `nudge-<uuid>` is 42. An invalid header is a
		// 400 for the whole send, so the transport trims rather than letting
		// every caller know about a transport detail.
		const actual = jest.requireActual("./webpush");
		const topic = actual.topicFor(`nudge-${"a1b2c3d4-e5f6-7890-abcd-ef1234567890"}`);
		expect(topic.length).toBeLessThanOrEqual(32);
		expect(topic).toMatch(/^[A-Za-z0-9\-_]+$/);
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

describe("the test notification", () => {
	test("reaches the person's devices without writing a nudge", async () => {
		db();
		const result = await push.sendTest(PROFILE);

		expect(result.sent).toBe(1);
		expect(fcm.send).toHaveBeenCalledTimes(1);
		// Its own collapse key, so proving the path works cannot knock a real
		// unread nudge off the lock screen.
		expect(fcm.send.mock.calls[0][1].collapseKey).toBe("athena-test");
		expect(fcm.send.mock.calls[0][1].data).toEqual({ kind: "test" });
		// A test is not an interruption. Recording one would spend a slot from
		// the daily cap and give the nightly review a delivery to score.
		const wrote = pool.query.mock.calls.some(([sql]) => /INSERT|athena_nudge/i.test(sql));
		expect(wrote).toBe(false);
	});

	test("says so rather than sending when the person has push switched off", async () => {
		db({ pushEnabled: 0 });
		const result = await push.sendTest(PROFILE);

		// Bypassing their own switch would prove the server works while
		// telling them nothing about whether Athena can reach them.
		expect(result).toMatchObject({ sent: 0, skipped: "not enabled" });
		expect(fcm.send).not.toHaveBeenCalled();
	});

	test("says so rather than sending when no transport is configured", async () => {
		// Both, because either one alone is enough to reach somebody — and
		// "your phone works but this browser cannot" must not read as a dead
		// server.
		fcm.isConfigured.mockResolvedValue(false);
		webpush.isConfigured.mockResolvedValue(false);
		db();
		const result = await push.sendTest(PROFILE);

		expect(result).toMatchObject({ sent: 0, skipped: "not configured" });
		expect(fcm.send).not.toHaveBeenCalled();
	});

	test("names the handset that refused, and why", async () => {
		db({ devices: [deviceRow(), deviceRow({ id: 8, uuid: "dev-2", name: "Car" })] });
		fcm.send
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ ok: false, dead: false, reason: "UNAVAILABLE" });

		const result = await push.sendTest(PROFILE);

		// "1 of 2" is not a diagnosis. The point of the test button is the
		// failure case, so the reason has to survive to the caller.
		expect(result).toMatchObject({ sent: 1, failed: 1, devices: 2 });
		expect(result.results).toEqual([
			expect.objectContaining({ uuid: "dev-1", ok: true, reason: null }),
			expect.objectContaining({ uuid: "dev-2", ok: false, reason: "UNAVAILABLE" }),
		]);
	});
});

describe("a browser registering itself", () => {
	const SUBSCRIPTION = {
		endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
		keys: { p256dh: "BN".padEnd(87, "x"), auth: "k".repeat(22) },
	};

	test("the browser is never handed a credential", async () => {
		const out = await push.registerBrowser(PROFILE, {
			subscription: SUBSCRIPTION,
			browserId: "browser-one",
			name: "Chrome on Windows",
		});

		// A device token in localStorage would be strictly worse than the
		// httpOnly session the page already has. The row is server-owned.
		expect(out).not.toHaveProperty("device_token");
		expect(JSON.stringify(out)).not.toMatch(/athd_/);
		expect(out).toMatchObject({ browserId: "browser-one", provider: "webpush" });
	});

	test("the same browser updates its row instead of collecting new ones", async () => {
		const first = await push.registerBrowser(PROFILE, {
			subscription: SUBSCRIPTION,
			browserId: "browser-one",
		});
		const second = await push.registerBrowser(PROFILE, {
			subscription: SUBSCRIPTION,
			browserId: "browser-one",
		});
		expect(second.device_uuid).toBe(first.device_uuid);
		expect(pool.query.mock.calls[0][0]).toContain("ON DUPLICATE KEY UPDATE");
	});

	test("two people using the same browser id get different rows", async () => {
		// browser_id is an identifier, not a credential — everything is scoped
		// to the profile the session proved, so a collision must not let one
		// person overwrite another's subscription.
		const mine = await push.registerBrowser(PROFILE, {
			subscription: SUBSCRIPTION,
			browserId: "shared",
		});
		const theirs = await push.registerBrowser(PROFILE + 1, {
			subscription: SUBSCRIPTION,
			browserId: "shared",
		});
		expect(mine.device_uuid).not.toBe(theirs.device_uuid);
	});

	test("a malformed subscription is refused on the way in", async () => {
		// Storing one means a send that fails forever, discovered the first
		// time she has something to say.
		await expect(
			push.registerBrowser(PROFILE, { subscription: { endpoint: "https://x" } })
		).rejects.toMatchObject({ code: "bad_token" });
		await expect(
			push.registerBrowser(PROFILE, { subscription: { ...SUBSCRIPTION, endpoint: "http://insecure" } })
		).rejects.toMatchObject({ code: "bad_token" });
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("the subscription is encrypted before it is stored", async () => {
		await push.registerBrowser(PROFILE, { subscription: SUBSCRIPTION, browserId: "browser-one" });
		const [, params] = pool.query.mock.calls[0];
		expect(params.some((p) => String(p).startsWith("enc:"))).toBe(true);
		expect(params).not.toContain(JSON.stringify(SUBSCRIPTION));
	});

	test("turning it off revokes the row rather than leaving it reachable", async () => {
		await push.forgetBrowser(PROFILE, "browser-one");
		const [sql, params] = pool.query.mock.calls[0];
		expect(sql).toContain("push_token_enc = NULL");
		expect(sql).toContain("revoked_at = NOW()");
		// Scoped to the caller, so one person cannot silence another's browser.
		expect(params).toContain(PROFILE);
	});
});
