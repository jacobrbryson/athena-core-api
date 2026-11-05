/**
 * The server's copy of the clients' speech split. The cases are the ones in
 * companion/scripts/speechChunks.test.mjs: the server voices a reply's first
 * part ahead (speechCache), and that only helps when its first part is
 * exactly the client's.
 */
const { speechChunks, sentences, clauseCut } = require("./speechChunks");

describe("speechChunks (mirrors the clients)", () => {
	test("only a reply of a few words is voiced whole", () => {
		expect(speechChunks("Sure. It is ten past four.")).toEqual(["Sure. It is ten past four."]);
		expect(speechChunks("It is ten past four, and the group run starts at five, so there is plenty of time.")).toHaveLength(2);
		expect(speechChunks("   ")).toEqual([]);
	});

	test("a long first sentence is cut to its opening clause, and a tiny opener joins it", () => {
		const reply =
			"Sure. Your first meeting is the design review at ten, and it runs about an hour. " +
			"After that you are free until lunch with Sam at noon. " +
			"The afternoon is clear, so it would be a good time for the run you mentioned yesterday.";
		const parts = speechChunks(reply);
		expect(parts[0]).toBe("Sure. Your first meeting is the design review at ten,");
		expect(parts[1]).toBe("and it runs about an hour.");
		expect(parts.length).toBeGreaterThanOrEqual(3);
		expect(parts.join(" ")).toBe(reply);
	});

	test("no words are lost or reordered, and no part is over the server limit", () => {
		const reply = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} has a few words in it!`).join(" ");
		const parts = speechChunks(reply);
		expect(parts.join(" ")).toBe(reply);
		expect(parts.every((part) => part.length <= 780)).toBe(true);
		expect(parts[1].length).toBeLessThanOrEqual(220);
	});

	test("abbreviations and initials don't end a sentence", () => {
		expect(sentences("Dr. Smith is in. J. R. R. Tolkien wrote it. ")).toEqual(["Dr. Smith is in. ", "J. R. R. Tolkien wrote it. "]);
		expect(clauseCut("short")).toBe(-1);
	});
});
