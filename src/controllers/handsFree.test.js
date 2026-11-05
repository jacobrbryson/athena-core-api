const { parseTurn, recordTurn } = require("./handsFree");

describe("hands-free turn timings", () => {
	test("keeps known stages and fields, drops everything else", () => {
		const turn = parseTurn({
			path: "wake",
			outcome: "answered",
			transcriber: "on-device",
			confidence: 0.4321,
			words: 3,
			messageUuid: "0b7f6c1e-1f2a-4c3d-9e8f-123456789abc",
			stages: { named: 640, ready: 2100, speechEnd: 4300.6, done: 15000, bogus: 5, sent: -3 },
			text: "the person's words",
		});
		expect(turn).toMatchObject({ path: "wake", outcome: "answered", transcriber: "on-device", confidence: 0.43, words: 3 });
		expect(turn.stages).toEqual({ named: 640, ready: 2100, speechEnd: 4301, done: 15000 });
		expect(JSON.stringify(turn)).not.toContain("person's words");
	});

	test("unknown enums, bad uuids and out-of-range numbers do not pass through", () => {
		const turn = parseTurn({ path: "x", outcome: "y", transcriber: "cloud", confidence: 3, messageUuid: "drop table", error: "e".repeat(500) });
		expect(turn).toMatchObject({ path: "unknown", outcome: "unknown", transcriber: null, confidence: null, messageUuid: null });
		expect(turn.error).toHaveLength(160);
	});

	test("conversation turns the phone dropped say why, without words", () => {
		const turn = parseTurn({
			path: "conversation",
			outcome: "notYou",
			car: true,
			stages: { ready: 200, speechStart: 900, notYou: 4100 },
			voiceFilter: { why: "not your voice", score: 0.2149, voicedMs: 2300, text: "my secret plan" },
		});
		expect(turn).toMatchObject({ path: "conversation", outcome: "notYou", car: true });
		expect(turn.stages.notYou).toBe(4100);
		expect(turn.voiceFilter).toEqual({ why: "not your voice", score: 0.21, voicedMs: 2300 });
		expect(JSON.stringify(turn)).not.toContain("secret plan");
	});

	test("a voice-filter verdict is only fixed reasons and bounded numbers", () => {
		const turn = parseTurn({ path: "conversationPickup", voiceFilter: { why: "free text", score: 9, voicedMs: -4 } });
		expect(turn.path).toBe("conversationPickup");
		expect(turn.car).toBe(false);
		expect(turn.voiceFilter).toEqual({ why: "unknown", score: null, voicedMs: null });
		expect(parseTurn({}).voiceFilter).toBeNull();
	});

	test("writes one structured line and answers 204", () => {
		const log = jest.spyOn(console, "log").mockImplementation(() => {});
		const res = { status: jest.fn().mockReturnThis(), end: jest.fn() };
		recordTurn({ body: { outcome: "error", error: "Athena answered 429" } }, res);
		const line = JSON.parse(log.mock.calls[0][0]);
		expect(line).toMatchObject({ severity: "WARNING", message: "[handsfree] turn", handsFree: { error: "Athena answered 429" } });
		expect(res.status).toHaveBeenCalledWith(204);
		log.mockRestore();
	});
});
