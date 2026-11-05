jest.mock("./gemini", () => ({ generateSpeech: jest.fn() }));
const gemini = require("./gemini");
const speechCache = require("./speechCache");

beforeEach(() => {
	speechCache._reset();
	gemini.generateSpeech.mockReset();
});

describe("speechCache", () => {
	test("voices a text once, and /speech takes it once", async () => {
		gemini.generateSpeech.mockResolvedValue({ audioBase64: "AAA", sampleRate: 24000 });
		speechCache.prefetch("  Let me check your calendar.  ");
		speechCache.prefetch("Let me check your calendar.");
		expect(gemini.generateSpeech).toHaveBeenCalledTimes(1);
		expect(gemini.generateSpeech).toHaveBeenCalledWith("Let me check your calendar.");
		await expect(speechCache.take("Let me check your calendar.")).resolves.toEqual({ audioBase64: "AAA", sampleRate: 24000 });
		await expect(speechCache.take("Let me check your calendar.")).resolves.toBeNull();
	});

	test("a failed prefetch is forgotten, so /speech makes it as usual", async () => {
		jest.spyOn(console, "warn").mockImplementation(() => {});
		gemini.generateSpeech.mockRejectedValue(new Error("quota"));
		speechCache.prefetch("Hello there, this is a reply.");
		await expect(speechCache.take("Hello there, this is a reply.")).resolves.toBeNull();
		await new Promise((r) => setImmediate(r));
		expect(speechCache._size()).toBe(0);
		console.warn.mockRestore();
	});

	test("nothing for text it never voiced, empty text, or text too long for /speech", async () => {
		speechCache.prefetch("");
		speechCache.prefetch("x".repeat(801));
		expect(gemini.generateSpeech).not.toHaveBeenCalled();
		await expect(speechCache.take("never voiced")).resolves.toBeNull();
	});

	test("an old clip is not handed out", async () => {
		jest.useFakeTimers();
		try {
			gemini.generateSpeech.mockResolvedValue({ audioBase64: "OLD" });
			speechCache.prefetch("A reply from a while ago.");
			jest.advanceTimersByTime(speechCache.TTL_MS + 1);
			await expect(speechCache.take("A reply from a while ago.")).resolves.toBeNull();
		} finally {
			jest.useRealTimers();
		}
	});
});
