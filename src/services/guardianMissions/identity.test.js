const pool = require("../../helpers/db");
const crypto = require("../../helpers/crypto");
const identity = require("./identity");
const voiceprints = require("./voiceprints");

jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../helpers/crypto", () => ({ encrypt: jest.fn(async (v) => `enc:${v}`), decrypt: jest.fn(async (v) => v.replace(/^enc:/, "")) }));
jest.mock("../push", () => ({ profileForNumber: jest.fn() }));

/** Answer each query by the first matching pattern; anything else is empty. */
function answer(routes) {
	pool.query.mockImplementation(async (sql) => {
		const hit = routes.find(([pattern]) => pattern.test(sql));
		return [hit ? hit[1] : []];
	});
}

const writes = (pattern) => pool.query.mock.calls.filter(([sql]) => pattern.test(sql));

beforeEach(() => pool.query.mockReset());

describe("labels and trust", () => {
	test("labels read plainly and carry no address", () => {
		expect(identity.labelFor("Thomas", { platform: "sms", channel: "sms" })).toBe("Thomas's phone, by text");
		expect(identity.labelFor("Ross", { platform: "web", channel: "push" })).toBe("Ross's browser, by notification");
		expect(identity.labelFor("Skylar", { channel: "walkie" })).toBe("Skylar, by walkie-talkie");
	});

	test("a platform maps to a channel, and an unknown one to nothing", () => {
		expect(identity.channelFor("sms")).toEqual({ channel: "sms", trust: "number" });
		expect(identity.channelFor("android")).toEqual({ channel: "push", trust: "paired" });
		expect(identity.channelFor("toaster")).toBeNull();
	});

	test("the most trusted channel comes first", () => {
		const ranked = identity.rank([{ trust: "shared" }, { trust: "number" }, { trust: "paired" }]);
		expect(ranked.map((c) => c.trust)).toEqual(["paired", "number", "shared"]);
	});
});

describe("syncDevices", () => {
	test("opens a link for a new device", async () => {
		answer([
			[/FROM athena_gm_actor/, [{ id: 3, profile_id: 3 }]],
			[/FROM paired_device/, [{ id: 7, name: "Pixel", platform: "android", profile_id: 3 }]],
		]);
		await identity.syncDevices(1);
		const [[, params]] = writes(/INSERT IGNORE INTO athena_gm_contact_point/);
		expect(params.slice(1, 7)).toEqual([1, 3, "push", 7, "Pixel", "paired"]);
	});

	test("ends a link when its device goes, keeping the row", async () => {
		answer([
			[/FROM athena_gm_actor/, [{ id: 3, profile_id: 3 }]],
			[/SELECT id, actor_id, device_id, trust/, [{ id: 50, actor_id: 3, device_id: 7, trust: "paired" }]],
		]);
		await identity.syncDevices(1);
		expect(writes(/SET valid_to = NOW\(\)/)).toHaveLength(1);
		expect(writes(/DELETE/)).toHaveLength(0);
	});

	test("a device two people sit behind is shared", async () => {
		answer([
			[/FROM athena_gm_actor/, [{ id: 3, profile_id: 9 }, { id: 4, profile_id: 9 }]],
			[/FROM paired_device/, [{ id: 7, name: "Family tablet", platform: "android", profile_id: 9 }]],
		]);
		await identity.syncDevices(1);
		const inserted = writes(/INSERT IGNORE INTO athena_gm_contact_point/);
		expect(inserted).toHaveLength(2);
		expect(inserted.every(([, params]) => params[6] === "shared")).toBe(true);
	});
});

describe("whoIs", () => {
	const row = (over = {}) => ({ id: 50, uuid: "c", actor_id: 3, actor_uuid: "a", display_name: "Thomas", kind: "kid", channel: "sms", device_id: 7, trust: "number", platform: "sms", reachable: 1, ...over });
	const known = (rows) => answer([[/SELECT DISTINCT a.family_id/, [{ family_id: 1 }]], [/FROM athena_gm_contact_point c/, rows]]);

	test("a device with no Guardian or parent is unknown", async () => {
		answer([]);
		expect(await identity.whoIs({ deviceId: 7, channel: "sms" })).toMatchObject({ known: false, person: null });
		expect(await identity.whoIs({ deviceId: null, channel: "sms" })).toMatchObject({ known: false });
	});

	test("a number leads to the person, in plain words", async () => {
		known([row()]);
		const who = await identity.whoIs({ deviceId: 7, channel: "sms" });
		expect(who.person).toEqual({ uuid: "a", name: "Thomas", kind: "kid" });
		expect(who.label).toBe("Thomas's phone, by text");
	});

	test("a shared device names who it might be, never one person", async () => {
		known([row({ trust: "shared", platform: "android", channel: "push" }), row({ actor_id: 4, actor_uuid: "b", display_name: "Skylar", trust: "shared", platform: "android", channel: "push" })]);
		const who = await identity.whoIs({ deviceId: 7, channel: "push" });
		expect(who.person).toBeNull();
		expect(who.actorId).toBeNull();
		expect(who.candidates.map((c) => c.name)).toEqual(["Thomas", "Skylar"]);
		expect(who.label).toBe("A shared phone, by notification");
	});

	test("a number nobody registered stops at unknown", async () => {
		require("../push").profileForNumber.mockResolvedValue(null);
		expect(await identity.whoIsNumber("+15555550123")).toMatchObject({ known: false });
	});
});

describe("recording", () => {
	test("a failed insert never reaches the caller", async () => {
		pool.query.mockRejectedValue(new Error("no table"));
		await expect(identity.recordContact({ familyId: 1, direction: "out", channel: "push", outcome: "sent" })).resolves.toBeUndefined();
		await expect(identity.recordDelivery(1, { id: 3 }, { id: 1, mission_id: 2 }, { results: [{ uuid: "d", platform: "sms", ok: true }] })).resolves.toBeUndefined();
	});

	test("one event per device push tried", async () => {
		answer([[/FROM athena_gm_contact_point c/, [{ id: 50, device_uuid: "d1", channel: "push", trust: "paired" }]]]);
		await identity.recordDelivery(1, { id: 3 }, { id: 1, mission_id: 2 }, { results: [{ uuid: "d1", platform: "android", ok: true }, { uuid: "d2", platform: "sms", ok: false, reason: "bad number" }] });
		const events = writes(/INSERT INTO athena_gm_contact_event/);
		expect(events).toHaveLength(2);
		expect(events[0][1].slice(1, 7)).toEqual([3, 50, "out", "push", "paired", "sent"]);
		expect(events[1][1][4]).toBe("sms");
		expect(events[1][1][6]).toBe("failed");
	});

	test("nothing sent is still on the record, with the reason", async () => {
		answer([]);
		await identity.recordDelivery(1, { id: 3 }, { id: 1, mission_id: 2 }, { sent: 0, skipped: "no registered device" });
		const [[, params]] = writes(/INSERT INTO athena_gm_contact_event/);
		expect(params[6]).toBe("failed");
		expect(params[9]).toBe("no registered device");
	});

	test("a text from outside the Guardians is not recorded", async () => {
		answer([]);
		await identity.recordInboundText(7);
		expect(writes(/INSERT INTO athena_gm_contact_event/)).toHaveLength(0);
	});
});

describe("voiceprints", () => {
	const print = { familyId: 1, actorId: 3, model: "m1", print: [0.1, 0.2] };

	test("no consent record, no voiceprint", async () => {
		await expect(voiceprints.saveVoiceprint(print)).rejects.toMatchObject({ status: 403 });
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("stored encrypted, never as plain JSON", async () => {
		pool.query.mockResolvedValue([{}]);
		await voiceprints.saveVoiceprint({ ...print, consentEventId: 12 });
		const [, params] = pool.query.mock.calls[0];
		expect(params[4]).toBe("enc:[0.1,0.2]");
		expect(crypto.encrypt).toHaveBeenCalled();
	});

	test("reads back, skipping one it can't open", async () => {
		pool.query.mockResolvedValue([[{ actor_id: 3, print_enc: "enc:[1]" }, { actor_id: 4, print_enc: "enc:not json" }]]);
		expect(await voiceprints.readVoiceprints(1, "m1")).toEqual([{ actorId: 3, print: [1] }]);
	});

	test("forgetting deletes the row", async () => {
		pool.query.mockResolvedValue([{}]);
		await voiceprints.forgetVoiceprints(1, 3);
		expect(pool.query.mock.calls[0][0]).toMatch(/DELETE FROM athena_gm_voiceprint/);
	});
});
