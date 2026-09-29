jest.mock("./llm", () => ({ decide: jest.fn() }));
jest.mock("./connectors/context", () => ({ linkedProviders: jest.fn(), relevantConnectors: jest.fn() }));
jest.mock("./llm/adapters/jev", () => ({ configured: jest.fn(async () => true) }));
jest.mock("./heartRate", () => ({ getPref: jest.fn(), matches: jest.fn() }));

const llm = require("./llm");
const connectorContext = require("./connectors/context");
const heartRate = require("./heartRate");
const intent = require("./toolIntent");

const PROFILE = 7;

function answers(nouls, window = "later_today") {
	const out = { window: { type: "choice", choice: window, confidence: 0.8 } };
	for (const [id, p] of Object.entries(nouls)) out[id] = { type: "noul", noul: p };
	return { answers: out, model: "jev-1.13.0", latencyMs: 120 };
}

beforeEach(() => {
	jest.clearAllMocks();
	connectorContext.linkedProviders.mockResolvedValue(new Set(["google_calendar", "whoop", "strava"]));
	heartRate.getPref.mockResolvedValue({ enabled: true });
	connectorContext.relevantConnectors.mockReturnValue([]);
	heartRate.matches.mockReturnValue(false);
});

describe("guess", () => {
	it("hears 'anything going on tonight?' as a calendar question about tonight", async () => {
		llm.decide.mockResolvedValue(answers({ calendar: 0.94, whoop: 0.02, strava: 0.01, heart_rate: 0.01 }));
		const g = await intent.guess("Do I have anything going on tonight?", { profileId: PROFILE, audience: "adult" });
		expect(g.fetch).toEqual(["calendar"]);
		expect(g.announce).toEqual(["calendar"]);
		expect(g.filler).toEqual({ key: "calendar", text: "Let me check your calendar, hmm…" });
		expect(g.window).toBe("later_today");
		expect(g.days).toBe(1);
	});

	it("asks only about sources this person has connected", async () => {
		llm.decide.mockResolvedValue(answers({}));
		await intent.guess("how did I sleep?", { profileId: PROFILE, audience: "adult" });
		const asked = Object.keys(llm.decide.mock.calls[0][0].questions);
		expect(asked.sort()).toEqual(["calendar", "heart_rate", "strava", "whoop", "whoop_also", "window"].sort());
		expect(asked).not.toContain("email");
	});

	it("never offers live heart rate to a child", async () => {
		llm.decide.mockResolvedValue(answers({}));
		await intent.guess("what's my heart rate?", { profileId: PROFILE, audience: "child" });
		expect(llm.decide.mock.calls[0][0].questions).not.toHaveProperty("heart_rate");
		expect(heartRate.getPref).not.toHaveBeenCalled();
	});

	it("fetches on a hunch but only announces what it is sure of", async () => {
		llm.decide.mockResolvedValue(answers({ calendar: 0.5, whoop: 0.9, strava: 0.8, heart_rate: 0.1 }));
		const g = await intent.guess("was that ride too hard?", { profileId: PROFILE, audience: "adult" });
		expect(g.fetch).toEqual(["calendar", "whoop", "strava"]);
		expect(g.announce).toEqual(["whoop", "strava"]);
		expect(g.filler.text).toBe("Let me check WHOOP and Strava, hmm…");
	});

	it("announces nothing — and says nothing — when nothing is likely", async () => {
		llm.decide.mockResolvedValue(answers({ calendar: 0.05, whoop: 0.05, strava: 0.05, heart_rate: 0.05 }, "unspecified"));
		const g = await intent.guess("tell me a story about dragons", { profileId: PROFILE, audience: "adult" });
		expect(g.fetch).toEqual([]);
		expect(g.filler).toBeNull();
	});

	it("returns null instead of throwing when Jev fails", async () => {
		llm.decide.mockRejectedValue(new Error("Jev timed out after 800 ms"));
		const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
		await expect(intent.guess("anything tonight?", { profileId: PROFILE, audience: "adult" })).resolves.toBeNull();
		warn.mockRestore();
	});

	it("does not call Jev when nothing is connected", async () => {
		connectorContext.linkedProviders.mockResolvedValue(new Set());
		heartRate.getPref.mockResolvedValue({ enabled: false });
		expect(await intent.guess("anything tonight?", { profileId: PROFILE, audience: "adult" })).toBeNull();
		expect(llm.decide).not.toHaveBeenCalled();
	});

	it("skips quietly when this deployment has no Jev key", async () => {
		require("./llm/adapters/jev").configured.mockResolvedValueOnce(false);
		expect(await intent.guess("anything tonight?", { profileId: PROFILE, audience: "adult" })).toBeNull();
		expect(llm.decide).not.toHaveBeenCalled();
		expect(connectorContext.linkedProviders).not.toHaveBeenCalled();
	});

	it("treats an unknown window as unspecified", async () => {
		llm.decide.mockResolvedValue(answers({ calendar: 0.9 }, "someday"));
		const g = await intent.guess("anything on?", { profileId: PROFILE, audience: "adult" });
		expect(g.window).toBe("unspecified");
		expect(g.days).toBe(7);
	});
});

describe("fillerLine", () => {
	it("is deterministic whatever the order, so each combination is one clip", () => {
		expect(intent.fillerLine(["strava", "whoop"])).toEqual(intent.fillerLine(["whoop", "strava"]));
	});

	it("adds the heart-rate clause after the checks", () => {
		expect(intent.fillerLine(["whoop", "strava", "heart_rate"]).text).toBe(
			"Let me check WHOOP and Strava, and I'll grab your heart rate off the band too…"
		);
		expect(intent.fillerLine(["heart_rate"]).text).toBe("Let me grab your heart rate, hmm…");
	});
});

describe("extraGrounding", () => {
	const guessed = (fetch, days = 1) => ({ fetch, days });

	it("adds the calendar for 'tonight', narrowed to today", () => {
		expect(intent.extraGrounding(guessed(["calendar"]), "anything going on tonight?")).toEqual({
			providers: ["google_calendar"],
			daysByProvider: { google_calendar: 1 },
			heartRate: false,
		});
	});

	it("leaves out what a keyword gate already fetches", () => {
		connectorContext.relevantConnectors.mockReturnValue([{ PROVIDER: "google_calendar" }]);
		expect(intent.extraGrounding(guessed(["calendar"]), "what's on my calendar?")).toBeNull();
	});

	it("does not narrow WHOOP or Strava history to the calendar window", () => {
		const extra = intent.extraGrounding(guessed(["whoop", "strava", "heart_rate"]), "was that too much?");
		expect(extra.providers).toEqual(["whoop", "strava"]);
		expect(extra.daysByProvider).toEqual({});
		expect(extra.heartRate).toBe(true);
	});

	it("is null with no guess", () => {
		expect(intent.extraGrounding(null, "hi")).toBeNull();
		expect(intent.extraGrounding(guessed([]), "hi")).toBeNull();
	});
});
