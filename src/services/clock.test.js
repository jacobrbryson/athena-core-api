/**
 * The clock block exists because a model with no stated "now" invents one.
 * These tests pin the two things that made it wrong in the wild: the day must
 * come from the person's timezone, and the block must say so unambiguously.
 */
const clock = require("./clock");

// 10:00 PM Wednesday 16 September 2026 in New York; already Thursday in UTC.
const LATE_WEDNESDAY = new Date("2026-09-17T02:00:00Z");

describe("describeNow", () => {
	it("names the local day, not the UTC one", () => {
		const n = clock.describeNow(LATE_WEDNESDAY, "America/New_York");
		expect(n.weekday).toBe("Wednesday");
		expect(n.date).toBe("September 16, 2026");
		expect(n.iso).toBe("2026-09-16");
		expect(n.time).toBe("10:00 PM");
	});

	it("follows the timezone it is given", () => {
		expect(clock.describeNow(LATE_WEDNESDAY, "Australia/Sydney").weekday).toBe("Thursday");
		expect(clock.describeNow(LATE_WEDNESDAY, "UTC").iso).toBe("2026-09-17");
	});

	it("falls back to the default zone when the zone is junk or missing", () => {
		expect(clock.describeNow(LATE_WEDNESDAY, "Mars/Olympus").iso).toBe("2026-09-16");
		expect(clock.describeNow(LATE_WEDNESDAY, undefined).iso).toBe("2026-09-16");
	});
});

describe("buildClockBlock", () => {
	it("states the date and tells the model it outranks its own belief", () => {
		const block = clock.buildClockBlock({
			now: LATE_WEDNESDAY,
			timeZone: "America/New_York",
		});
		expect(block).toContain("Wednesday, September 16, 2026");
		expect(block).toContain("2026-09-16");
		expect(block).toContain("America/New_York");
		expect(block).toMatch(/authoritative/i);
		expect(block).toMatch(/never guess/i);
	});
});

describe("startOfDayIn / addDaysIn", () => {
	it("starts the day at local midnight, not the server's", () => {
		expect(clock.startOfDayIn(LATE_WEDNESDAY, "America/New_York").toISOString())
			.toBe("2026-09-16T04:00:00.000Z");
	});

	it("advances by calendar days across a DST change", () => {
		// 1 Nov 2026 ends EDT, so a week from 30 Oct is an hour further out.
		const start = clock.startOfDayIn(new Date("2026-10-30T12:00:00Z"), "America/New_York");
		expect(clock.addDaysIn(start, 7, "America/New_York").toISOString())
			.toBe("2026-11-06T05:00:00.000Z");
	});

	it("keeps server-local behaviour when no zone is supplied", () => {
		const start = clock.startOfDayIn(LATE_WEDNESDAY, null);
		expect(start.getHours()).toBe(0);
		expect(start.getMinutes()).toBe(0);
	});
});
