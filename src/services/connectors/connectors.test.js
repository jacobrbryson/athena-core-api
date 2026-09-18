/**
 * Phase 4 connectors: the provider-specific reads, their keyword gates, and
 * the aggregation that decides what reaches the prompt.
 */
const mockAccessToken = jest.fn();
const mockInvalidate = jest.fn();
jest.mock("./oauth", () => ({
	accessToken: mockAccessToken,
	invalidate: mockInvalidate,
}));

const mockList = jest.fn();
jest.mock("../credentials", () => ({ list: mockList }));

const googleCalendar = require("./googleCalendar");
const strava = require("./strava");
const whoop = require("./whoop");
const context = require("./context");
const { buildUrl, isNotConnected } = require("./http");
const { getProvider } = require("./registry");

const PROFILE = 42;

function apiResponse(body, { ok = true, status = 200 } = {}) {
	return {
		ok,
		status,
		text: async () => JSON.stringify(body),
	};
}

/** A calendarList body. `primary` first, the rest treated as shared. */
function calendarList(...names) {
	return apiResponse({
		items: names.map((name, i) => ({
			id: i === 0 ? "primary@example.com" : `${name.toLowerCase()}@group.calendar.google.com`,
			summary: name,
			timeZone: "America/New_York",
			...(i === 0 ? { primary: true } : {}),
		})),
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	googleCalendar.clearCalendarCache();
	mockAccessToken.mockResolvedValue("live-token");
	mockList.mockResolvedValue([
		{ provider: "google_calendar", status: "active" },
		{ provider: "strava", status: "active" },
		{ provider: "whoop", status: "active" },
	]);
	global.fetch = jest.fn();
	jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const lastUrl = () => new URL(global.fetch.mock.calls[0][0]);
const lastInit = () => global.fetch.mock.calls[0][1];
/** Nth fetch (0-based) — the calendar reads span several calls. */
const urlAt = (n) => new URL(global.fetch.mock.calls[n][0]);
const initAt = (n) => global.fetch.mock.calls[n][1];

describe("http layer", () => {
	it("preserves a path prefix on the provider's base URL", () => {
		// new URL("/v2/recovery", ".../developer") would drop /developer and
		// silently hit the host root.
		expect(buildUrl("https://api.prod.whoop.com/developer", "/v2/recovery", {})).toBe(
			"https://api.prod.whoop.com/developer/v2/recovery"
		);
	});

	it("appends query params and drops empty ones", () => {
		const url = buildUrl("https://x.test/api", "/a", { limit: 5, start: "", n: null });
		expect(url).toBe("https://x.test/api/a?limit=5");
	});

	it("rejects a path carrying a host or traversal", () => {
		expect(() => buildUrl("https://x.test", "https://evil.test/a", {})).toThrow(
			/root-relative/
		);
		expect(() => buildUrl("https://x.test", "/../../etc", {})).toThrow(/traversal/);
	});

	it("sends the bearer token", async () => {
		global.fetch.mockResolvedValue(apiResponse({ items: [] }));
		await googleCalendar.listEvents(PROFILE);
		expect(lastInit().headers.Authorization).toBe("Bearer live-token");
	});

	it("reports not_connected when nothing is linked", async () => {
		mockAccessToken.mockResolvedValue(null);
		const err = await googleCalendar.listEvents(PROFILE).catch((e) => e);
		expect(isNotConnected(err)).toBe(true);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("flags the link when the provider rejects a token we thought was live", async () => {
		global.fetch.mockResolvedValue(apiResponse({}, { ok: false, status: 401 }));
		const err = await strava.listActivities(PROFILE).catch((e) => e);
		expect(isNotConnected(err)).toBe(true);
		expect(mockInvalidate).toHaveBeenCalledWith(
			PROFILE,
			"strava",
			expect.stringContaining("401")
		);
	});

	it("does not flag the link when a 403 is only a rate limit", async () => {
		// Google answers 403 for quota and rate limits too. Reading those as
		// revocation tore down a healthy link and sent the user back through
		// consent — which is what made the calendar need reconnecting so often.
		global.fetch.mockResolvedValue(
			apiResponse(
				{
					error: {
						code: 403,
						message: "Rate Limit Exceeded",
						errors: [{ reason: "rateLimitExceeded" }],
					},
				},
				{ ok: false, status: 403 }
			)
		);

		const err = await strava.listActivities(PROFILE).catch((e) => e);
		expect(err.code).toBe("provider_error");
		expect(err.message).toMatch(/Rate Limit Exceeded/);
		expect(mockInvalidate).not.toHaveBeenCalled();
	});

	it("does not flag the link when one calendar of many answers 403", async () => {
		// A calendar the account may list but not read in detail says nothing
		// about the grant, and the fan-out is wide enough to trip a rate limit
		// on its own.
		global.fetch
			.mockResolvedValueOnce(calendarList("Mine", "Family"))
			.mockResolvedValueOnce(apiResponse({ items: [] }))
			.mockResolvedValueOnce(apiResponse({}, { ok: false, status: 403 }));

		await expect(googleCalendar.listEvents(PROFILE)).resolves.toEqual([]);
		expect(mockInvalidate).not.toHaveBeenCalled();
	});

	it("surfaces a provider error without flagging the link", async () => {
		global.fetch.mockResolvedValue(
			apiResponse({ message: "Rate Limit Exceeded" }, { ok: false, status: 429 })
		);
		const err = await strava.listActivities(PROFILE).catch((e) => e);
		expect(err.code).toBe("provider_error");
		expect(err.message).toMatch(/Rate Limit Exceeded/);
		expect(mockInvalidate).not.toHaveBeenCalled();
	});
});

describe("google calendar", () => {
	it("expands recurring events and orders them by start time", async () => {
		global.fetch
			.mockResolvedValueOnce(calendarList("Mine"))
			.mockResolvedValue(apiResponse({ items: [] }));
		await googleCalendar.listEvents(PROFILE, { days: 3 });

		expect(urlAt(0).pathname).toBe("/calendar/v3/users/me/calendarList");
		const url = urlAt(1);
		expect(url.pathname).toBe("/calendar/v3/calendars/primary%40example.com/events");
		// orderBy=startTime is only legal alongside singleEvents=true.
		expect(url.searchParams.get("singleEvents")).toBe("true");
		expect(url.searchParams.get("orderBy")).toBe("startTime");
		expect(url.searchParams.get("timeMin")).toBeTruthy();
	});

	it("normalizes timed and all-day events", async () => {
		global.fetch.mockResolvedValueOnce(calendarList("Mine")).mockResolvedValue(
			apiResponse({
				items: [
					{
						summary: "Standup",
						start: { dateTime: "2026-09-14T13:00:00Z" },
						end: { dateTime: "2026-09-14T13:15:00Z" },
						location: "Zoom",
						attendees: [{}, {}],
					},
					{ summary: "Holiday", start: { date: "2026-09-15" }, end: { date: "2026-09-16" } },
				],
			})
		);
		const events = await googleCalendar.listEvents(PROFILE);
		expect(events[0]).toMatchObject({
			title: "Standup",
			allDay: false,
			location: "Zoom",
			attendees: 2,
		});
		expect(events[1]).toMatchObject({ title: "Holiday", allDay: true });
	});

	it("reads every calendar and merges them in start order", async () => {
		// The shared household calendar is where the plans actually live — it
		// used to be invisible, because only `primary` was ever read.
		global.fetch
			.mockResolvedValueOnce(calendarList("Mine", "Family"))
			.mockResolvedValueOnce(
				apiResponse({
					items: [
						{ summary: "Standup", start: { dateTime: "2026-09-14T13:00:00Z" } },
					],
				})
			)
			.mockResolvedValueOnce(
				apiResponse({
					items: [
						{ summary: "Swim lesson", start: { dateTime: "2026-09-14T09:00:00Z" } },
					],
				})
			);

		const events = await googleCalendar.listEvents(PROFILE);
		expect(events.map((e) => e.title)).toEqual(["Swim lesson", "Standup"]);
		expect(events[0]).toMatchObject({ calendar: "Family", shared: true });
		expect(events[1]).toMatchObject({ calendar: "Mine", shared: false });
	});

	it("names the shared calendar in the prompt block", async () => {
		global.fetch
			.mockResolvedValueOnce(calendarList("Mine", "Family"))
			.mockResolvedValueOnce(
				apiResponse({
					items: [{ summary: "Swim lesson", start: { dateTime: "2026-09-14T09:00:00Z" } }],
				})
			)
			.mockResolvedValue(apiResponse({ items: [] }));

		const text = await googleCalendar.buildContext(PROFILE, { days: 7 });
		expect(text).toMatch(/your calendar and Family/);
		expect(text).toMatch(/Swim lesson/);
	});

	it("skips declined and cancelled events", async () => {
		global.fetch.mockResolvedValueOnce(calendarList("Mine")).mockResolvedValue(
			apiResponse({
				items: [
					{
						summary: "Declined meeting",
						start: { dateTime: "2026-09-14T13:00:00Z" },
						attendees: [{ self: true, responseStatus: "declined" }],
					},
					{
						summary: "Called off",
						status: "cancelled",
						start: { dateTime: "2026-09-14T14:00:00Z" },
					},
					{ summary: "Real one", start: { dateTime: "2026-09-14T15:00:00Z" } },
				],
			})
		);
		const events = await googleCalendar.listEvents(PROFILE);
		expect(events.map((e) => e.title)).toEqual(["Real one"]);
	});

	it("survives one calendar failing but not all of them", async () => {
		global.fetch
			.mockResolvedValueOnce(calendarList("Mine", "Family"))
			.mockResolvedValueOnce(
				apiResponse({
					items: [{ summary: "Standup", start: { dateTime: "2026-09-14T13:00:00Z" } }],
				})
			)
			.mockResolvedValueOnce(apiResponse({}, { ok: false, status: 500 }));
		expect((await googleCalendar.listEvents(PROFILE)).map((e) => e.title)).toEqual([
			"Standup",
		]);

		// But a total failure must NOT be reported as an empty schedule.
		jest.clearAllMocks();
		googleCalendar.clearCalendarCache();
		global.fetch
			.mockResolvedValueOnce(calendarList("Mine", "Family"))
			.mockResolvedValue(apiResponse({}, { ok: false, status: 500 }));
		await expect(googleCalendar.listEvents(PROFILE)).rejects.toThrow();
	});

	it("falls back to the primary calendar when the list is unreadable", async () => {
		global.fetch
			.mockResolvedValueOnce(apiResponse({}, { ok: false, status: 500 }))
			.mockResolvedValue(apiResponse({ items: [] }));
		await googleCalendar.listEvents(PROFILE);
		expect(urlAt(1).pathname).toBe("/calendar/v3/calendars/primary/events");
	});

	it("asks freeBusy about every calendar, with a POST body", async () => {
		global.fetch
			.mockResolvedValueOnce(calendarList("Mine", "Family"))
			.mockResolvedValueOnce(
				apiResponse({
					calendars: {
						"primary@example.com": { busy: [{ start: "a", end: "b" }] },
						"family@group.calendar.google.com": { busy: [{ start: "c", end: "d" }] },
					},
				})
			);
		const busy = await googleCalendar.freeBusy(PROFILE, { days: 2 });
		expect(initAt(1).method).toBe("POST");
		expect(JSON.parse(initAt(1).body).items).toEqual([
			{ id: "primary@example.com" },
			{ id: "family@group.calendar.google.com" },
		]);
		expect(busy).toEqual([
			{ start: "a", end: "b" },
			{ start: "c", end: "d" },
		]);
	});

	it("renders times in the account's own calendar zone, not UTC", async () => {
		// 13:00Z in September is 09:00 in New York. Telling someone their 9am
		// standup is at 1pm is worse than telling them nothing.
		global.fetch
			.mockResolvedValueOnce(calendarList("Mine"))
			.mockResolvedValue(
				apiResponse({
					items: [
						{ summary: "Standup", start: { dateTime: "2026-09-14T13:00:00Z" } },
					],
				})
			);
		const text = await googleCalendar.buildContext(PROFILE, { days: 7 });
		expect(text).toMatch(/local time, America\/New_York/);
		expect(text).toMatch(/Mon 2026-09-14 09:00 — Standup/);
		expect(text).not.toMatch(/13:00/);
	});

	it("takes the display zone from the primary calendar", () => {
		expect(
			googleCalendar.displayTimeZone([
				{ primary: false, timeZone: "Europe/Berlin" },
				{ primary: true, timeZone: "America/Chicago" },
			])
		).toBe("America/Chicago");
		// No zone anywhere (the calendar list was unreadable) stays explicit.
		expect(googleCalendar.displayTimeZone([{ primary: true, timeZone: null }])).toBe(
			"UTC"
		);
	});

	it("keeps an all-day event on its own date whatever the zone", () => {
		// A birthday is on the 15th in every timezone; shifting it into local
		// time would move it to the 14th for anyone west of UTC.
		expect(
			googleCalendar.formatEvent(
				{ title: "Birthday", start: "2026-09-15", allDay: true },
				"America/Los_Angeles"
			)
		).toBe("- Tue 2026-09-15 (all day) — Birthday");
	});

	it("falls back to UTC rather than dropping the block on a bad zone", () => {
		expect(
			googleCalendar.formatEvent(
				{ title: "Standup", start: "2026-09-14T13:00:00Z" },
				"Not/AZone"
			)
		).toBe("- 2026-09-14 13:00 — Standup");
	});

	it("coalesces busy blocks that overlap across calendars", () => {
		// Two people booked over the same hour is one busy stretch, not two.
		expect(
			googleCalendar.mergeIntervals([
				{ start: "2026-09-14T09:00:00Z", end: "2026-09-14T10:00:00Z" },
				{ start: "2026-09-14T09:30:00Z", end: "2026-09-14T11:00:00Z" },
				{ start: "2026-09-14T13:00:00Z", end: "2026-09-14T14:00:00Z" },
			])
		).toEqual([
			{ start: "2026-09-14T09:00:00Z", end: "2026-09-14T11:00:00Z" },
			{ start: "2026-09-14T13:00:00Z", end: "2026-09-14T14:00:00Z" },
		]);
	});

	it("clamps the window to a sane range", () => {
		const wide = googleCalendar.window(9999);
		// Rounded, not truncated: the window advances by CALENDAR days from
		// local midnight, so one crossing a DST boundary spans 60 days plus an
		// hour. That is the intent — a "day" is a day, not 86400 seconds.
		const span = (new Date(wide.timeMax) - new Date(wide.timeMin)) / 86_400_000;
		expect(Math.round(span)).toBe(60);
	});

	it("starts the window at the calendar's local midnight, not the server's", () => {
		// 10pm Wednesday in New York is already Thursday in UTC. A server
		// running UTC used to start "today" there, dropping this morning's
		// events and pulling in tomorrow's.
		const { timeMin } = googleCalendar.window(
			1,
			new Date("2026-09-17T02:00:00Z"),
			"America/New_York"
		);
		expect(timeMin).toBe("2026-09-16T04:00:00.000Z");
	});

	it("starts the window at midnight today, not right now", () => {
		// "What's on today?" must still list an event from earlier this morning.
		const { timeMin } = googleCalendar.window(1);
		const start = new Date(timeMin);
		expect(start.getHours()).toBe(0);
		expect(start.getMinutes()).toBe(0);
	});

	it("says so plainly when the calendar is empty", async () => {
		global.fetch
			.mockResolvedValueOnce(calendarList("Mine"))
			.mockResolvedValue(apiResponse({ items: [] }));
		expect(await googleCalendar.buildContext(PROFILE, { days: 7 })).toMatch(
			/nothing scheduled/
		);
	});
});

describe("strava", () => {
	it("filters by an epoch-seconds lower bound", async () => {
		global.fetch.mockResolvedValue(apiResponse([]));
		await strava.listActivities(PROFILE, { days: 7 });
		const after = Number(lastUrl().searchParams.get("after"));
		const expected = Math.floor((Date.now() - 7 * 86400_000) / 1000);
		expect(Math.abs(after - expected)).toBeLessThan(5);
	});

	it("converts metres to miles and keeps the raw value", async () => {
		global.fetch.mockResolvedValue(
			apiResponse([
				{ name: "Morning Run", sport_type: "Run", distance: 8046.72, moving_time: 2400 },
			])
		);
		const [activity] = await strava.listActivities(PROFILE);
		expect(activity.distance_mi).toBe(5);
		expect(activity.distance_m).toBe(8047);
	});

	it("totals a window and breaks it down by sport", () => {
		const { totals, bySport } = strava.summarize([
			{ type: "Run", distance_mi: 5, moving_time_s: 2400, elevation_gain_m: 50 },
			{ type: "Run", distance_mi: 3, moving_time_s: 1500, elevation_gain_m: 20 },
			{ type: "Ride", distance_mi: 20, moving_time_s: 3600, elevation_gain_m: 200 },
		]);
		expect(totals).toEqual({
			count: 3,
			distance_mi: 28,
			moving_time_s: 7500,
			elevation_gain_m: 270,
		});
		expect(bySport.Run).toMatchObject({ count: 2, distance_mi: 8 });
		expect(bySport.Ride).toMatchObject({ count: 1, distance_mi: 20 });
	});

	it("returns totals rather than a list for the totals tool", async () => {
		global.fetch.mockResolvedValue(
			apiResponse([{ sport_type: "Run", distance: 1609.344, moving_time: 600 }])
		);
		const result = await strava.executeTool("get_strava_totals", { days: 7 }, {
			profileId: PROFILE,
		});
		expect(result.totals.count).toBe(1);
		expect(result.totals.distance_mi).toBe(1);
		expect(result).not.toHaveProperty("activities");
	});
});

describe("whoop", () => {
	it("reads recovery from the v2 collection with a start bound", async () => {
		global.fetch.mockResolvedValue(apiResponse({ records: [] }));
		await whoop.listRecovery(PROFILE, { days: 7 });
		const url = lastUrl();
		expect(url.pathname).toBe("/developer/v2/recovery");
		expect(url.searchParams.get("start")).toBeTruthy();
	});

	it("clamps limit to Whoop's ceiling of 25", async () => {
		global.fetch.mockResolvedValue(apiResponse({ records: [] }));
		await whoop.listRecovery(PROFILE, { limit: 500 });
		expect(lastUrl().searchParams.get("limit")).toBe("25");
	});

	it("flattens a recovery record", async () => {
		global.fetch.mockResolvedValue(
			apiResponse({
				records: [
					{
						created_at: "2026-09-12T10:00:00Z",
						score_state: "SCORED",
						score: { recovery_score: 71, resting_heart_rate: 48, hrv_rmssd_milli: 92.4 },
					},
				],
			})
		);
		const [day] = await whoop.listRecovery(PROFILE);
		expect(day).toMatchObject({
			date: "2026-09-12",
			recovery_score: 71,
			resting_heart_rate: 48,
			hrv_ms: 92.4,
		});
	});

	it("derives hours asleep by removing awake time from time in bed", async () => {
		global.fetch.mockResolvedValue(
			apiResponse({
				records: [
					{
						end: "2026-09-12T13:00:00Z",
						nap: false,
						score: {
							sleep_performance_percentage: 88,
							stage_summary: {
								total_in_bed_time_milli: 8 * 3_600_000,
								total_awake_time_milli: 0.5 * 3_600_000,
							},
						},
					},
				],
			})
		);
		const [night] = await whoop.listSleep(PROFILE);
		expect(night.hours_in_bed).toBe(8);
		expect(night.hours_asleep).toBe(7.5);
		expect(night.sleep_performance_percent).toBe(88);
	});

	it("reports rather than hides a total Whoop outage", async () => {
		global.fetch.mockResolvedValue(apiResponse({}, { ok: false, status: 500 }));
		// Not null: the caller must be able to tell an outage from a quiet week.
		await expect(whoop.buildContext(PROFILE)).rejects.toThrow(/Whoop/);
	});

	it("keeps the section that worked when only one fails", async () => {
		global.fetch
			.mockResolvedValueOnce(apiResponse({ records: [] }))
			.mockResolvedValue(apiResponse({}, { ok: false, status: 500 }));
		await expect(whoop.buildContext(PROFILE)).resolves.toMatch(/Whoop/);
	});

	it("asks for the cycles scope that day strain is read under", () => {
		// /v2/cycle is scoped separately from recovery. Without it the strain
		// card 401s on every dashboard load.
		expect(getProvider("whoop").scopes).toEqual(
			expect.arrayContaining(["read:cycles"])
		);
	});

	it("does not flag the link when one collection answers 401", async () => {
		// A dashboard load reads recovery, sleep and cycles at once. One of
		// them refused is a scope problem with that collection, not a revoked
		// grant — flagging it here is what put "access expired" on the panel
		// after every page refresh.
		global.fetch.mockResolvedValue(apiResponse({}, { ok: false, status: 401 }));
		await expect(whoop.listCycles(PROFILE)).rejects.toMatchObject({
			code: "not_connected",
		});
		expect(mockInvalidate).not.toHaveBeenCalled();
	});

	it("still flags the link when the account-level profile read is refused", async () => {
		global.fetch.mockResolvedValue(apiResponse({}, { ok: false, status: 401 }));
		await expect(whoop.getProfile(PROFILE)).rejects.toMatchObject({
			code: "not_connected",
		});
		expect(mockInvalidate).toHaveBeenCalledWith(PROFILE, "whoop", expect.any(String));
	});
});

describe("keyword gates", () => {
	const cases = [
		["what's on my calendar tomorrow?", ["google_calendar"]],
		["am I free thursday afternoon?", ["google_calendar"]],
		["how far did I run this week?", ["strava"]],
		["what was my recovery this morning?", ["whoop"]],
		["how did I sleep last night?", ["whoop"]],
		["did my training affect my recovery?", ["strava", "whoop"]],
		["what should we have for dinner?", []],
		["tell me a story about dragons", []],
	];

	it.each(cases)("routes %j", (message, expected) => {
		expect(context.relevantConnectors(message).map((c) => c.PROVIDER).sort()).toEqual(
			[...expected].sort()
		);
	});

	it("costs nothing for an unrelated message", async () => {
		expect(context.messageNeedsConnectors("what's for dinner?")).toBe(false);
		expect(await context.buildContext(PROFILE, { message: "what's for dinner?" })).toBeNull();
		expect(mockList).not.toHaveBeenCalled();
		expect(global.fetch).not.toHaveBeenCalled();
	});
});

describe("context aggregation", () => {
	it("only queries providers the user has actually linked", async () => {
		mockList.mockResolvedValue([{ provider: "strava", status: "active" }]);
		global.fetch.mockResolvedValue(apiResponse([]));

		const text = await context.buildContext(PROFILE, {
			message: "how was my run and what's on my calendar?",
		});
		// Only the linked provider is actually called...
		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(text).toMatch(/Strava/);
		// ...but the unlinked one is still accounted for, rather than left to
		// the model's imagination.
		expect(text).toMatch(/Google Calendar: NOT connected/);
	});

	it("never calls a revoked link, and says it needs reconnecting", async () => {
		mockList.mockResolvedValue([{ provider: "strava", status: "needs_reauth" }]);

		const text = await context.buildContext(PROFILE, {
			message: "how far did I run?",
		});
		expect(text).toMatch(/Strava: linked, but the connection is no longer authorized/);
		expect(text).toMatch(/reconnected/);
		// Not the first-time-setup wording: they did link it once.
		expect(text).not.toMatch(/has not linked the account yet/);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("keeps one provider's block when another fails", async () => {
		global.fetch
			.mockResolvedValueOnce(apiResponse([{ sport_type: "Run", distance: 1609.344, moving_time: 600 }]))
			.mockRejectedValue(new Error("whoop is down"));

		const text = await context.buildContext(PROFILE, {
			message: "how was my run and my recovery?",
		});
		expect(text).toMatch(/Strava/);
		// The Strava data block survives, and Whoop contributes a failure
		// notice rather than nothing — but no Whoop DATA block.
		expect(text).not.toMatch(/Whoop —/);
		expect(text).toMatch(/Whoop: linked, but temporarily unreachable/);
	});

	// The regression that made a fully-working calendar look like an unbuilt
	// feature: every layer turned "cannot read it" into "nothing to say", so
	// the model was handed an empty prompt and invented both a schedule and an
	// excuse. A linked-but-failing provider must always say so.
	describe("a linked provider that fails is never silent", () => {
		const ask = () =>
			context.buildContext(PROFILE, { message: "what's on my calendar today?" });

		beforeEach(() => {
			mockList.mockResolvedValue([
				{ provider: "google_calendar", status: "active" },
			]);
		});

		it("reports an unreadable credential as OUR fault, not a reconnect", async () => {
			mockAccessToken.mockRejectedValue(
				Object.assign(new Error("cannot decrypt"), {
					code: "credential_unreadable",
				})
			);

			const text = await ask();
			expect(text).toMatch(/Google Calendar: linked/);
			expect(text).toMatch(/cannot read the stored credential/);
			expect(text).toMatch(/NOT something the user can fix by reconnecting/);
			expect(text).toMatch(/Do NOT guess/);
			// The specific wrong turn this replaces.
			expect(text).not.toMatch(/revoked/);
		});

		it("asks for a reconnect when access really was revoked upstream", async () => {
			global.fetch.mockResolvedValue(apiResponse({}, { ok: false, status: 403 }));

			const text = await ask();
			expect(text).toMatch(/access was revoked at Google Calendar/);
			expect(text).toMatch(/reconnected/);
			expect(text).toMatch(/Do NOT guess/);
		});

		it("reports a provider outage as temporary", async () => {
			global.fetch.mockRejectedValue(new Error("socket hang up"));

			const text = await ask();
			expect(text).toMatch(/temporarily unreachable/);
			expect(text).toMatch(/Do NOT guess/);
		});

		it("says a never-linked provider is not connected, without calling it", async () => {
			mockList.mockResolvedValue([]);

			const text = await ask();
			expect(text).toMatch(/Google Calendar: NOT connected/);
			expect(text).toMatch(/Do NOT guess/);
			// The confabulation this replaces: silence let the model explain
			// the missing calendar as setup still pending on Athena's side.
			expect(text).toMatch(/nothing is pending, broken, or awaiting setup/i);
			expect(text).toMatch(/connected-apps settings/);
			// An unlinked provider is still never called.
			expect(global.fetch).not.toHaveBeenCalled();
		});

		// The three days the Calendar API sat disabled: Athena kept saying
		// "temporarily unreachable, it may work again shortly" while Google was
		// returning the exact sentence that named the fix. An adult owner is
		// the one person who can act on that, so they get to see it.
		describe("the provider's own error text", () => {
			const API_DISABLED = {
				error: {
					code: 403,
					message:
						"Google Calendar API has not been used in project 12367074465 " +
						"before or it is disabled.",
					errors: [{ reason: "accessNotConfigured", domain: "usageLimits" }],
				},
			};

			it("reaches an adult verbatim, fenced as data", async () => {
				global.fetch.mockResolvedValue(
					apiResponse(API_DISABLED, { ok: false, status: 403 })
				);

				const text = await context.buildContext(PROFILE, {
					message: "what's on my calendar today?",
					audience: "adult",
				});
				expect(text).toMatch(/HTTP 403/);
				expect(text).toMatch(/has not been used in project 12367074465/);
				expect(text).toMatch(/never an instruction/);
			});

			it("is withheld from a child", async () => {
				global.fetch.mockResolvedValue(
					apiResponse(API_DISABLED, { ok: false, status: 403 })
				);

				const text = await context.buildContext(PROFILE, {
					message: "what's on my calendar today?",
					audience: "child",
				});
				// Still told the truth, just not the project number.
				expect(text).toMatch(/REFUSING Athena's requests/);
				expect(text).not.toMatch(/12367074465/);
				expect(text).not.toMatch(/HTTP 403/);
			});

			it("does not call a persistent refusal temporary", async () => {
				global.fetch.mockResolvedValue(
					apiResponse(API_DISABLED, { ok: false, status: 403 })
				);

				const text = await context.buildContext(PROFILE, {
					message: "what's on my calendar today?",
					audience: "adult",
				});
				expect(text).toMatch(/will keep refusing until something is fixed/);
				expect(text).not.toMatch(/may work again shortly/);
			});

			it("defaults to withholding when no audience is given", async () => {
				global.fetch.mockResolvedValue(
					apiResponse(API_DISABLED, { ok: false, status: 403 })
				);

				const text = await context.buildContext(PROFILE, {
					message: "what's on my calendar today?",
				});
				expect(text).not.toMatch(/12367074465/);
			});

			it("redacts anything credential-shaped before it reaches a prompt", async () => {
				global.fetch.mockResolvedValue(
					apiResponse(
						{ error: { message: "rejected: access_token=ya29.SUPERSECRET bad" } },
						{ ok: false, status: 400 }
					)
				);

				const text = await context.buildContext(PROFILE, {
					message: "what's on my calendar today?",
					audience: "adult",
				});
				expect(text).not.toMatch(/ya29\.SUPERSECRET/);
				expect(text).toMatch(/\[redacted\]/);
			});

			it("explains a transport failure too", async () => {
				global.fetch.mockRejectedValue(new Error("socket hang up"));

				const text = await context.buildContext(PROFILE, {
					message: "what's on my calendar today?",
					audience: "adult",
				});
				expect(text).toMatch(/socket hang up/);
			});
		});

		it("does not mention a provider the message was not about", async () => {
			mockList.mockResolvedValue([]);
			const text = await ask();
			expect(text).not.toMatch(/Whoop/);
			expect(text).not.toMatch(/Strava/);
		});
	});

	it("offers tools only for linked, relevant providers", async () => {
		mockList.mockResolvedValue([{ provider: "whoop", status: "active" }]);
		const tools = await context.toolsFor(PROFILE, "how did I sleep and what's on my calendar?");
		expect(tools.map((t) => t.name).sort()).toEqual([
			"get_whoop_recovery",
			"get_whoop_sleep",
			"get_whoop_strain",
		]);
	});

	it("dispatches a tool call to the connector that declared it", async () => {
		global.fetch.mockResolvedValue(apiResponse({ records: [] }));
		const result = await context.executeTool("get_whoop_sleep", { days: 3 }, {
			profileId: PROFILE,
		});
		expect(result).toHaveProperty("sleep");
		expect(lastUrl().pathname).toBe("/developer/v2/activity/sleep");
	});

	it("rejects an unknown tool name", async () => {
		await expect(
			context.executeTool("get_facebook_feed", {}, { profileId: PROFILE })
		).rejects.toThrow(/Unknown connector tool/);
	});

	it("declares no duplicate tool names across connectors", () => {
		const names = context.CONNECTORS.flatMap((c) =>
			c.FUNCTION_DECLARATIONS.map((d) => d.name)
		);
		expect(new Set(names).size).toBe(names.length);
	});
});
