const mockRequest = jest.fn();
jest.mock("google-auth-library", () => ({
	GoogleAuth: jest.fn().mockImplementation(() => ({
		getProjectId: async () => "athena-476423",
		getCredentials: async () => ({ client_email: "runner@athena-476423.iam.gserviceaccount.com" }),
		getClient: async () => ({ request: mockRequest }),
	})),
}));

const wakeups = require("./reminderWakeups");

beforeEach(() => {
	jest.clearAllMocks();
	wakeups._reset();
	process.env.REMINDER_WAKEUPS_IN_TESTS = "1";
	delete process.env.GCP_PROJECT_ID;
	jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	delete process.env.REMINDER_WAKEUPS_IN_TESTS;
	jest.restoreAllMocks();
});

test("books one Cloud Task that runs the reminders job at that time, named by the minute", async () => {
	mockRequest.mockResolvedValue({ data: {} });
	const at = new Date(Date.now() + 3600_000);
	expect(await wakeups.wakeAt(at)).toBe(true);
	const { url, data } = mockRequest.mock.calls[0][0];
	expect(url).toBe("https://cloudtasks.googleapis.com/v2/projects/athena-476423/locations/us-central1/queues/athena-reminders/tasks");
	const fire = new Date(data.task.scheduleTime).getTime();
	expect(fire - at.getTime()).toBe(5000);
	expect(data.task.name).toBe(`projects/athena-476423/locations/us-central1/queues/athena-reminders/tasks/wake-${Math.floor(fire / 60_000)}`);
	expect(data.task.httpRequest).toEqual({
		httpMethod: "POST",
		url: "https://run.googleapis.com/v2/projects/athena-476423/locations/us-central1/jobs/athena-reminders:run",
		oauthToken: { serviceAccountEmail: "runner@athena-476423.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/cloud-platform" },
	});
});

test("a run already booked for that minute is success", async () => {
	mockRequest.mockRejectedValue(Object.assign(new Error("Requested entity already exists"), { response: { status: 409 } }));
	expect(await wakeups.wakeAt(new Date(Date.now() + 60_000))).toBe(true);
});

test("a failure never throws — the hourly backstop covers it", async () => {
	mockRequest.mockRejectedValue(new Error("PERMISSION_DENIED"));
	expect(await wakeups.wakeAt(new Date())).toBe(false);
	expect(await wakeups.wakeAt("not a date")).toBe(false);
});

test("ignores the local .env's project id, which resolves nowhere", async () => {
	process.env.GCP_PROJECT_ID = "athena";
	mockRequest.mockResolvedValue({ data: {} });
	await wakeups.wakeAt(new Date());
	expect(mockRequest.mock.calls[0][0].url).toContain("projects/athena-476423/");
});
