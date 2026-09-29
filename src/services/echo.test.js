const { isEcho } = require("./echo");

const REPLY =
	"You've got piano lessons at six tonight, and then nothing else until tomorrow morning's dentist appointment at nine.";

describe("isEcho", () => {
	it("catches her own reply coming back, even misheard and clipped", () => {
		expect(isEcho("piano lessons at six tonight and then nothing else until tomorrow", REPLY)).toBe(true);
		expect(isEcho("you got piano lessons at 6 tonight and then nothing else", REPLY)).toBe(true);
		expect(isEcho("mornings dentist appointment at nine", REPLY)).toBe(true);
	});

	it("lets real follow-ups through, even when they reuse her words", () => {
		expect(isEcho("and tomorrow?", REPLY)).toBe(false);
		expect(isEcho("what time is the dentist tomorrow", REPLY)).toBe(false);
		expect(isEcho("can you move piano lessons to seven", REPLY)).toBe(false);
		expect(isEcho("yes", REPLY)).toBe(false);
	});

	it("never calls anything an echo of nothing", () => {
		expect(isEcho("piano lessons at six tonight", "")).toBe(false);
	});
});
