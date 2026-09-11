/**
 * Companion platform tests: device pairing, perception, the adult companion
 * prompt, and the chat pipeline's validation-driven model fallback.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));

const pool = require("../helpers/db");

beforeEach(() => pool.query.mockReset());

describe("device pairing", () => {
	const devices = require("./devices");
	beforeEach(() => devices._clearCache());

	test("codes are 8 unambiguous characters, formatted XXXX-XXXX", async () => {
		pool.query.mockResolvedValue([{ affectedRows: 1 }]);
		const { code, expires_in } = await devices.createPairingCode(42, { name: "Pixel" });
		expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
		expect(expires_in).toBe(600);
		// Only the hash is stored.
		const params = pool.query.mock.calls[0][1];
		expect(params).not.toContain(code);
		expect(params).not.toContain(code.replace("-", ""));
	});

	test("normalizes what people type", () => {
		expect(devices.normalizeCode(" abcd-2345 ")).toBe("ABCD2345");
	});

	test("redeem returns an opaque token once; unknown codes get null", async () => {
		pool.query
			.mockResolvedValueOnce([[{ id: 1, uuid: "dev-1", profile_uuid: "prof-1" }]])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);
		const paired = await devices.redeemPairingCode("ABCD-2345", { name: "Car" });
		expect(paired.device_token).toMatch(/^athd_[A-Za-z0-9_-]{40,}$/);
		expect(paired).toMatchObject({ device_uuid: "dev-1", profile_uuid: "prof-1" });

		pool.query.mockResolvedValueOnce([[]]);
		expect(await devices.redeemPairingCode("ZZZZ-2345")).toBeNull();
	});

	test("tokens authenticate against the table and results are cached briefly", async () => {
		pool.query.mockResolvedValueOnce([[{ id: 9, uuid: "dev-9", profile_id: 42, platform: "android" }]]).mockResolvedValue([{}]);
		const a = await devices.authenticateDeviceToken("athd_abc");
		const b = await devices.authenticateDeviceToken("athd_abc");
		expect(a).toEqual({ deviceId: 9, deviceUuid: "dev-9", profileId: 42, platform: "android" });
		expect(b).toEqual(a);
		const lookups = pool.query.mock.calls.filter(([sql]) => sql.includes("token_hash = ?"));
		expect(lookups).toHaveLength(1);
	});

	test("non-device strings are rejected without a DB hit", async () => {
		expect(await devices.authenticateDeviceToken("Bearer eyJ...")).toBeNull();
		expect(pool.query).not.toHaveBeenCalled();
	});
});

describe("perception", () => {
	jest.resetModules();
	jest.doMock("./memoryStore/events", () => ({ createEvent: jest.fn().mockResolvedValue({}) }));
	jest.doMock("./llm", () => ({ generateJson: jest.fn() }));
	const perception = require("./perception");
	const { createEvent } = require("./memoryStore/events");
	const llm = require("./llm");

	beforeEach(() => {
		perception._reset();
		createEvent.mockClear();
		llm.generateJson.mockReset();
	});

	test("sanitizes and clamps device JSON", () => {
		const s = perception.sanitizeScene({
			objects: [{ label: "tree", distance_m: 12, bearing_deg: 400, confidence: 3 }, { distance_m: 5 }],
		});
		expect(s.objects).toEqual([
			{ label: "tree", description: null, distance_m: 12, bearing_deg: 180, confidence: 1, track_id: null },
		]);
	});

	test("a fresh scene renders into the prompt; a stale one doesn't", async () => {
		await perception.ingestObservation(42, {
			source: { kind: "phone", position: "front" },
			summary: "Two-lane road, light traffic",
			objects: [{ label: "car", description: "white pickup", distance_m: 12, bearing_deg: -3 }],
			context: { driving: true },
		});
		const block = perception.getPromptBlock(42);
		expect(block).toMatch(/white pickup — 12 m, ahead/);
		expect(block).toMatch(/DRIVING/);
		expect(perception.getPromptBlock(42, Date.now() + 60_000)).toMatch(/Earlier in the last few minutes/);
		expect(perception.getPromptBlock(42, Date.now() + 60 * 60_000)).toBeNull();
	});

	test("keyframes go through the vision model and notable sightings become memories", async () => {
		llm.generateJson.mockResolvedValue({
			data: { summary: "A deer at the roadside", objects: [{ label: "deer", description: "adult deer", distance_m: 30, bearing_deg: 20, confidence: 0.9 }], hazards: ["deer near road"], notable: true },
			endpointId: "orc-a",
			tier: "orcwood",
		});
		const scene = await perception.ingestObservation(42, { keyframe: { imageBase64: "A".repeat(200) }, source: { kind: "uvc" } });
		expect(llm.generateJson).toHaveBeenCalledWith(expect.objectContaining({ task: "vision" }));
		expect(scene.servedBy).toEqual({ endpointId: "orc-a", tier: "orcwood" });
		expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "observation", profileId: 42 }));
	});
});

describe("adult companion prompt", () => {
	const { buildAdultCompanionPrompt } = require("../controllers/prompt");

	test("keeps the shared JSON contract and addresses the person", () => {
		const p = buildAdultCompanionPrompt({}, [{ category: "pet", key: "dog", value: "Biscuit" }], { firstName: "Ross" });
		expect(p).toMatch(/personal AI companion to \*\*Ross\*\*/);
		expect(p).toMatch(/action: "NO_CHANGE"/);
		expect(p).toMatch(/\(pet\) dog: Biscuit/);
	});

	test("driving mode demands short spoken replies", () => {
		const p = buildAdultCompanionPrompt({}, [], { companion: { device: "car", driving: true } });
		expect(p).toMatch(/through their car/);
		expect(p).toMatch(/They are DRIVING/);
	});
});

describe("chat pipeline fallback", () => {
	jest.resetModules();

	test("an invalid reply from the first tier falls through to a valid one and is saved", async () => {
		jest.doMock("../helpers/db", () => ({ query: jest.fn().mockResolvedValue([[]]) }));
		const addMessage = jest.fn().mockResolvedValue("ai-uuid");
		jest.doMock("./message", () => ({ addMessage, getMessages: jest.fn().mockResolvedValue([]) }));
		jest.doMock("./session", () => ({ updateSession: jest.fn().mockResolvedValue({}) }));
		jest.doMock("./sessionTopic", () => ({ getSessionTopics: jest.fn().mockResolvedValue([]) }));
		jest.doMock("./integration", () => ({ messageNeedsFamilyChores: () => false }));
		jest.doMock("./mission", () => ({}));
		const afterTurn = jest.fn();
		jest.doMock("./memoryStore", () => ({
			buildMemoryContext: jest.fn().mockResolvedValue({ audience: "adult", memoryEnabled: true, promptBlock: null }),
			afterTurn,
		}));
		jest.doMock("../controllers/prompt", () => ({ generatePrompt: jest.fn().mockResolvedValue("PROMPT") }));

		const replies = ["not json at all", JSON.stringify({ response: "Hi Ross", action: "NO_CHANGE", topic_name: "", new_proficiency: -1, is_factually_true: true })];
		jest.doMock("./llm", () => ({
			generate: jest.fn(async ({ validate }) => {
				for (const text of replies) {
					if (!validate(text)) return { text, endpointId: "x", tier: "orcwood" };
				}
				throw new Error("none valid");
			}),
		}));

		const { processAiResponse } = require("../controllers/gemini");
		await processAiResponse({ id: 1, uuid: "s1", mode: "companion", profile_id: 42 }, "hello there", new Map(), {});
		expect(addMessage).toHaveBeenCalledWith(1, false, "Hi Ross", "companion");
		expect(afterTurn).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "hello there", { audience: "adult", memoryEnabled: true });
	});
});
