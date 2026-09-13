const smokeTest = require("./smokeTest");
const { isSmoke } = require("../services/llm/telemetry");

const run = (headers) =>
	new Promise((resolve) => smokeTest({ headers }, {}, () => resolve(isSmoke())));

test("marks the request when the header is set", async () => {
	await expect(run({ "x-athena-smoke": "1" })).resolves.toBe(true);
	await expect(run({ "x-athena-smoke": "true" })).resolves.toBe(true);
});

test("leaves ordinary traffic alone", async () => {
	await expect(run({})).resolves.toBe(false);
	// Only an explicit opt-in counts — no truthiness games.
	await expect(run({ "x-athena-smoke": "0" })).resolves.toBe(false);
	await expect(run({ "x-athena-smoke": "yes" })).resolves.toBe(false);
});
