const { mayUse, attention } = require("./gate");
const trackRecord = require("./trackRecord");
const geo = require("./geo");
const { landmarkBearings, labelKey, instructionFor } = require("./scout");
const team = require("./team");

jest.mock("../../helpers/db", () => ({ query: jest.fn() }));

const cap = (over = {}) => ({ id: 1, name: "Porch light", enabled: 1, mission_only: 0, house_control: 0, permission: "free", ...over });
const running = (over = {}) => ({ status: "running", approval_state: "approved", capabilityIds: [1], ...over });
const NOW = new Date("2026-10-29T20:00:00Z");
const agreed = { allowed: true };

describe("gate.mayUse", () => {
	test("the kill switch refuses house controls and nothing else", () => {
		const control = { mode: "running", kill_switch: 1 };
		expect(mayUse({ control, capability: cap({ house_control: 1 }), mission: running() }).verdict).toBe("refuse");
		expect(mayUse({ control, capability: cap(), mission: running() }).verdict).toBe("allow");
	});

	test("a disabled capability is refused", () => {
		expect(mayUse({ control: null, capability: cap({ enabled: 0 }) }).verdict).toBe("refuse");
	});

	test("least privilege: a mission may touch only what it lists", () => {
		const d = mayUse({ control: null, capability: cap({ id: 9 }), mission: running() });
		expect(d.verdict).toBe("refuse");
		expect(d.reason).toMatch(/not one of this mission/);
	});

	test("an unapproved or stopped mission can't use anything", () => {
		expect(mayUse({ control: null, capability: cap(), mission: running({ approval_state: "unapproved" }) }).verdict).toBe("refuse");
		expect(mayUse({ control: null, capability: cap(), mission: running({ status: "stopped" }) }).verdict).toBe("refuse");
	});

	test("mission mode: lights and kid messages only while a mission runs", () => {
		expect(mayUse({ control: null, capability: cap({ mission_only: 1 }) }).verdict).toBe("refuse");
		expect(mayUse({ control: null, capability: cap({ mission_only: 1 }), mission: running() }).verdict).toBe("allow");
		expect(mayUse({ control: null, capability: cap(), recipient: { kind: "kid", display_name: "Thomas" }, consent: agreed }).verdict).toBe("refuse");
	});

	test("pause, quiet-until and mute HOLD - they never refuse", () => {
		const m = running();
		expect(mayUse({ control: { mode: "paused" }, capability: cap(), mission: m, now: NOW }).verdict).toBe("hold");
		const quiet = mayUse({ control: { mode: "quiet_until", quiet_until: "2026-10-29T22:00:00Z" }, capability: cap(), mission: m, now: NOW });
		expect(quiet.verdict).toBe("hold");
		expect(quiet.until).toEqual(new Date("2026-10-29T22:00:00Z"));
		// A quiet time that has passed no longer holds.
		expect(mayUse({ control: { mode: "quiet_until", quiet_until: "2026-10-29T19:00:00Z" }, capability: cap(), mission: m, now: NOW }).verdict).toBe("allow");
		const muted = { kind: "parent", display_name: "Ross", muted: 1, muted_until: null };
		expect(mayUse({ control: null, capability: cap(), mission: m, recipient: muted, consent: agreed, now: NOW }).verdict).toBe("hold");
		expect(mayUse({ control: null, capability: cap(), mission: m, recipient: { ...muted, muted_until: "2026-10-29T10:00:00Z" }, consent: agreed, now: NOW }).verdict).toBe("allow");
	});

	test("no agreement refuses before any hold, and fails closed", () => {
		const person = { kind: "parent", display_name: "Ross", muted: 1 };
		expect(mayUse({ control: null, capability: cap(), mission: running(), recipient: person }).verdict).toBe("refuse");
		const left = mayUse({ control: { mode: "paused" }, capability: cap(), mission: running(), recipient: person, consent: { allowed: false, reason: "they left" } });
		expect(left.verdict).toBe("refuse");
		expect(left.reason).toMatch(/they left/);
	});

	test("contact is default-deny: only Guardians and their parents", () => {
		expect(mayUse({ control: null, capability: cap(), mission: running(), recipient: { kind: "guest", display_name: "A vendor" }, consent: agreed }).verdict).toBe("refuse");
		expect(mayUse({ control: null, capability: cap(), mission: running(), flags: { contactsOutsider: true } }).verdict).toBe("refuse");
	});

	test("money and parent-approval capabilities need a per-call approval", () => {
		expect(mayUse({ control: null, capability: cap(), mission: running() }).needsApproval).toBe(false);
		expect(mayUse({ control: null, capability: cap({ permission: "parent_approval" }), mission: running() }).needsApproval).toBe(true);
		expect(mayUse({ control: null, capability: cap(), mission: running(), flags: { spendsMoney: true } }).needsApproval).toBe(true);
	});

	test("there is no rate limit: the hundredth ask is allowed like the first", () => {
		for (let i = 0; i < 100; i++) expect(mayUse({ control: null, capability: cap(), mission: running(), now: NOW }).verdict).toBe("allow");
	});
});

describe("gate.attention", () => {
	test("green, yellow, red", () => {
		expect(attention({ steps: [], now: NOW })).toBe("green");
		expect(attention({ steps: [], proposedCount: 2, now: NOW })).toBe("yellow");
		expect(attention({ steps: [{ status: "waiting_parent", due_at: "2026-10-30T00:00:00Z" }], now: NOW })).toBe("yellow");
		expect(attention({ steps: [{ status: "waiting_parent", due_at: "2026-10-29T12:00:00Z" }], now: NOW })).toBe("red");
		expect(attention({ steps: [{ status: "stuck" }], now: NOW })).toBe("red");
		expect(attention({ steps: [{ status: "waiting_kids" }], now: NOW })).toBe("green");
	});
});

describe("trackRecord", () => {
	const r = (passed, latency_ms = 500, stage = "command") => ({ passed: passed ? 1 : 0, latency_ms, stage, created_at: NOW });

	test("12 tests, 11 passed reads as the owner wrote it", () => {
		const results = [...Array(11).fill(0).map(() => r(true)), r(false)];
		const s = trackRecord.summarize(results);
		expect(trackRecord.describe(s)).toBe("12 tests, 11 passed, average delay 0.5s");
		expect(s.status).toBe("working");
	});

	test("status is arithmetic: untested, broken, flaky", () => {
		expect(trackRecord.statusOf([])).toBe("untested");
		expect(trackRecord.statusOf([r(false), r(false), r(false), r(true)])).toBe("broken");
		expect(trackRecord.statusOf([r(true), r(false), r(true), r(false)])).toBe("flaky");
	});

	test("stages are counted apart so the shaky part shows", () => {
		const s = trackRecord.summarize([r(true, 100, "upload"), r(false, 100, "analysis"), r(true, 100, "upload")]);
		expect(s.stages).toEqual({ upload: { total: 2, passed: 2 }, analysis: { total: 1, passed: 0 } });
	});

	test("stale after 30 days, and never-tested counts as stale", () => {
		expect(trackRecord.isStale(null, NOW)).toBe(true);
		expect(trackRecord.isStale("2026-10-20T00:00:00Z", NOW)).toBe(false);
		expect(trackRecord.isStale("2026-09-01T00:00:00Z", NOW)).toBe(true);
	});
});

describe("geo", () => {
	test("bearing inside a photo uses its heading and position across the frame", () => {
		expect(geo.bearingInPhoto(90, 0.5)).toBe(90);
		expect(geo.bearingInPhoto(0, 0)).toBeCloseTo(360 - 32.5);
		expect(geo.bearingInPhoto(null, 0.5)).toBeNull();
	});

	test("two heading lines cross at the object", () => {
		const a = { lat: 35.5, lng: -80.9 };
		const b = { lat: 35.5, lng: -80.8995 }; // ~45 m east of a
		// From a looking north-east and from b looking north-west: the object is north of the midpoint.
		const fix = geo.intersect(a, 45, b, 315);
		expect(fix).not.toBeNull();
		expect(fix.lat).toBeGreaterThan(35.5);
		expect(fix.lng).toBeCloseTo(-80.89975, 5);
		expect(fix.crossDeg).toBe(90);
	});

	test("near-parallel or backwards lines give no fix", () => {
		const a = { lat: 35.5, lng: -80.9 };
		const b = { lat: 35.5, lng: -80.8995 };
		expect(geo.intersect(a, 0, b, 5)).toBeNull();
		expect(geo.intersect(a, 225, b, 135)).toBeNull();
	});
});

describe("scout helpers", () => {
	test("landmarks become bearings from that photo's own heading", () => {
		const latest = new Map([["E", { heading_deg: "92.0" }]]);
		const out = landmarkBearings([{ label: "The red planter", direction: "E", x: 0.5 }, { label: "Shed", direction: "N", x: 0.2 }], latest);
		expect(out).toEqual([{ label: "The red planter", key: "red planter", bearing: 92 }]);
		expect(labelKey("An Old Oak!")).toBe("old oak");
	});

	test("the ask is self-contained: what, where, proof", () => {
		const text = instructionFor({ place: "the back porch", dueAt: null });
		expect(text).toMatch(/back porch/);
		expect(text).toMatch(/north, east, south, then west/);
		expect(text).toMatch(/Proof:/);
	});
});

describe("team progress", () => {
	test("a Guardian with nothing recorded is a level 1 Recruit", () => {
		expect(team.standing({})).toEqual({ level: 1, role: "Recruit", levelProgress: 0 });
	});

	test("level comes from what they did, role from where most of it is", () => {
		const s = team.standing({ checkedIn: true, finds: 26 });
		expect(s.level).toBe(6);
		expect(s.levelProgress).toBe(60);
		expect(s.role).toBe("Tracker");
		expect(team.standing({ checkedIn: true }).role).toBe("Sage");
		expect(team.standing({ trailKeys: 10, finds: 1 }).role).toBe("Builder");
	});

	test("a skill with nothing to count is not started, not zero", () => {
		const skills = team.teamSkills({ missionsFinished: 4, missionsStarted: 5, familiesReported: 2, familiesTotal: 4, keysDecoded: 24, keysPossible: 30, cluesFound: 0, cluesTotal: 0, checkedIn: 11, roster: 14, reliableBadges: 0, badgesPossible: 10 });
		const by = Object.fromEntries(skills.map((s) => [s.key, s]));
		expect(by.planning.percent).toBe(80);
		expect(by.teamwork.detail).toBe("2 of 4 families reported their map piece");
		expect(by.observation.percent).toBeNull();
		expect(by.realWorldTools.percent).toBe(0);
	});

	test("activity is newest first, says who by first name, and skips people off the team", () => {
		const names = { g1: "Thomas", g2: "Livia" };
		const rows = team.activityFrom({
			finds: [{ found_by_guardian_id: "g2", found_at: "2026-07-27T18:00:00Z", entry_id: "F-01" }, { found_by_guardian_id: "test", found_at: "2026-07-28T18:00:00Z", entry_id: "F-02" }],
			keys: [{ guardian_id: "g1", used_at: "2026-07-29T18:00:00Z" }],
			contributions: [],
			nameOf: (id) => names[id] || null,
			titleOf: () => "the ledger line",
		});
		expect(rows.map((r) => r.who)).toEqual(["Thomas", "Livia"]);
		expect(rows[1].text).toBe("found the ledger line");
		expect(JSON.stringify(rows)).not.toMatch(/g1|g2|F-01/);
	});

	test("only a first name leaves", () => {
		expect(team.firstName("Thomas Bryson")).toBe("Thomas");
	});
});
