/**
 * Smoke-test labelling.
 *
 * Testing against production is real traffic, but it is not evidence about how
 * Athena is serving people. The label keeps it out of the health metrics while
 * keeping the row itself intact — an error is still an error, still logged,
 * still attributed to an endpoint.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn().mockResolvedValue([[]]) }));

const pool = require("../../helpers/db");
const telemetry = require("./telemetry");

const call = (over = {}) => ({
	task: "vision",
	endpointId: "gemini",
	tier: "frontier",
	outcome: "ok",
	latencyMs: 10,
	...over,
});

const loggedTask = () => pool.query.mock.calls.at(-1)[1][0];

beforeEach(() => pool.query.mockClear());

test("outside runAsSmoke the task is untouched", () => {
	telemetry.recordCall(call());
	expect(loggedTask()).toBe("vision");
	expect(telemetry.recent(1)[0].task).toBe("vision");
});

test("inside runAsSmoke the task is prefixed, in the ring and the row alike", () => {
	telemetry.runAsSmoke(() => telemetry.recordCall(call({ outcome: "error", error: "bad image" })));
	expect(loggedTask()).toBe("smoke:vision");
	const [row] = telemetry.recent(1);
	expect(row.task).toBe("smoke:vision");
	// The failure itself is still on the record.
	expect(row.outcome).toBe("error");
	expect(row.error).toBe("bad image");
});

test("the label follows async work started inside the request", async () => {
	await telemetry.runAsSmoke(async () => {
		await new Promise((r) => setTimeout(r, 1));
		telemetry.recordCall(call({ task: "chat" }));
	});
	expect(loggedTask()).toBe("smoke:chat");
});

test("the label does not leak into later calls", async () => {
	await telemetry.runAsSmoke(async () => telemetry.recordCall(call()));
	telemetry.recordCall(call({ task: "chat" }));
	expect(loggedTask()).toBe("chat");
});

test("a long task name still fits the task column", () => {
	telemetry.runAsSmoke(() => telemetry.recordCall(call({ task: "a".repeat(40) })));
	expect(loggedTask().length).toBeLessThanOrEqual(24);
	expect(loggedTask().startsWith("smoke:")).toBe(true);
});
