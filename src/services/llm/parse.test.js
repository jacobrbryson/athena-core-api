/**
 * Tolerant model-output parsing.
 *
 * The escaped-quote case is the real failure that made ~10% of production chat
 * replies unparseable (the prompt used to be JSON-stringified into one user
 * message, so the model echoed that escaping back).
 */
const { parseModelJson, extractBlock } = require("./parse");

describe("parseModelJson", () => {
	test("plain JSON", () => {
		expect(parseModelJson('{"response":"hi","action":"NO_CHANGE"}')).toEqual({
			response: "hi",
			action: "NO_CHANGE",
		});
	});

	test("recovers the real production failure: escaped quotes throughout", () => {
		const raw =
			'{\n  \\"response\\": \\"Rough day? Or just the general weight of existence before coffee?\\",\n' +
			'  \\"is_factually_true\\": true,\n  \\"action\\": \\"NO_CHANGE\\",\n  \\"topic_name\\": \\"\\",\n' +
			'  \\"new_proficiency\\": -1\n}';
		expect(() => JSON.parse(raw)).toThrow(); // what production saw
		expect(parseModelJson(raw)).toEqual({
			response: "Rough day? Or just the general weight of existence before coffee?",
			is_factually_true: true,
			action: "NO_CHANGE",
			topic_name: "",
			new_proficiency: -1,
		});
	});

	test("markdown fences", () => {
		expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
	});

	test("JSON embedded in prose", () => {
		expect(parseModelJson('Sure! Here you go:\n{"a":1, "b":"}"}\nHope that helps.')).toEqual({ a: 1, b: "}" });
	});

	test("legitimate escapes inside real JSON strings are preserved", () => {
		expect(parseModelJson('{"response":"She said \\"hi\\" and left.\\nThen quiet."}')).toEqual({
			response: 'She said "hi" and left.\nThen quiet.',
		});
	});

	test("unrecoverable output returns null", () => {
		expect(parseModelJson("I cannot answer that.")).toBeNull();
		expect(parseModelJson('{"response": "truncated mid')).toBeNull();
		expect(parseModelJson("")).toBeNull();
		expect(parseModelJson(null)).toBeNull();
	});

	test("extractBlock ignores braces inside strings", () => {
		expect(extractBlock('prefix {"a":"{not a brace}"} suffix')).toBe('{"a":"{not a brace}"}');
	});
});
