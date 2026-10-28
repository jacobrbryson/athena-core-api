jest.mock("../../helpers/db", () => ({ query: jest.fn() }));

const { createOutage } = require("./index");
const classify = require("./classify");
const evidence = require("./evidence");

const T0 = new Date("2026-10-27T18:10:00Z"); // 2:10 PM in New York
const min = (n) => new Date(T0.getTime() + n * 60_000);

function memoryStore(seed = {}) {
	const s = {
		episodes: [],
		assessments: [],
		nudges: [],
		offline: seed.offline || [],
		online: new Map(),
		health: { state: "unknown", since: null, lastOkAt: null, reportedSince: null, recoveryPending: false },
		incidents: seed.incidents || [],
		nestError: seed.nestError || null,
	};
	return {
		s,
		openEpisode: async () => s.episodes.find((e) => e.open_key === "open") || null,
		createEpisode: async ({ uuid, openedAt, signals }) => {
			const open = s.episodes.find((e) => e.open_key === "open");
			if (open) return { episode: open, created: false };
			const e = { id: s.episodes.length + 1, uuid, open_key: "open", state: "open", opened_at: openedAt, signals };
			s.episodes.push(e);
			return { episode: e, created: true };
		},
		updateEpisode: async (id, fields, { close = false } = {}) => {
			const e = s.episodes.find((x) => x.id === id);
			Object.assign(e, fields);
			if (close) e.open_key = null;
		},
		addAssessment: async (a) => s.assessments.push(a),
		lastAssessmentAt: async () => (s.assessments.length ? s.assessments[s.assessments.length - 1].at : null),
		pruneAssessments: async () => undefined,
		nestOffline: async () => {
			if (s.nestError) throw new Error(s.nestError);
			return s.offline;
		},
		nestOnlineSince: async () => s.online,
		siteStatus: async () => ({ checked: 2, failing: 0 }),
		phoneLastSeen: async () => min(-5),
		situations: async () => [{ profileId: 1, incidents: s.incidents }],
		insertNudge: async (n) => {
			if (s.nudges.some((x) => x.profileId === n.profileId && x.dedupeKey === n.dedupeKey)) return false;
			s.nudges.push(n);
			return true;
		},
		bridgeHealth: async () => ({ ...s.health }),
		saveBridgeHealth: async (h) => {
			s.health = { state: h.state, since: h.since, lastOkAt: h.lastOkAt, reportedSince: h.reportedSince, recoveryPending: h.recoveryPending };
		},
	};
}

const thermostats = [
	{ name: "t1", label: "Upstairs Thermostat", offlineSince: min(-12) },
	{ name: "t2", label: "Den Thermostat", offlineSince: min(-10) },
];

function build({ store = memoryStore({ offline: thermostats }), bridge = { configured: true, reachable: false, error: "timeout" }, search, nws, now = T0, recipients = [1, 2] } = {}) {
	const pushed = [];
	const llm = {
		search: jest.fn(search || (async () => ({ text: "Duke Energy reports about 4,000 customers without power near Charlotte.", sources: [{ title: "Duke Energy", url: "https://example.test/x" }] }))),
		generateJson: jest.fn(async () => ({ data: { found: true, scope: "widespread", summary: "About 4,000 customers are without power after a transformer failure.", source: "Duke Energy", restoration: "3:30 PM" } })),
	};
	let health = bridge;
	const outage = createOutage({
		store,
		recipients: () => recipients,
		bridgeHealth: async () => health,
		places: async () => [{ uuid: "p", name: "Home", kind: "home", address: "1 Main St, Charlotte, NC 28202", latitude: 35.2, longitude: -80.8 }],
		nws: nws || (async () => []),
		llm: () => llm,
		push: () => ({ deliverNudge: jest.fn(async (profileId, n) => (pushed.push({ profileId, ...n }), { sent: 1 })) }),
		wake: jest.fn(async () => true),
		now: () => now,
	});
	return { outage, store, pushed, llm, setBridge: (b) => (health = b) };
}

describe("classify", () => {
	test("two thermostats that dropped together and a silent bridge are an outage", () => {
		const c = classify.classify({ now: T0, nest: thermostats, bridge: { reachable: false } });
		expect(c.suspected).toBe(true);
		expect(c.items.map((i) => i.label)).toEqual(["Upstairs Thermostat", "Den Thermostat", "the camera bridge"]);
	});
	test("one thermostat alone is not", () => {
		expect(classify.classify({ now: T0, nest: [thermostats[0]], bridge: { reachable: true, state: "ready" } }).suspected).toBe(false);
	});
	test("a thermostat offline for a day is not part of it", () => {
		const old = { name: "t0", label: "Garage", offlineSince: new Date(T0.getTime() - 26 * 3600_000) };
		expect(classify.classify({ now: T0, nest: [old, thermostats[0]], bridge: { reachable: true } }).suspected).toBe(false);
	});
	test("thermostats forty minutes apart did not go dark together", () => {
		const far = [{ ...thermostats[0], offlineSince: min(-50) }, { ...thermostats[1], offlineSince: min(-5) }];
		expect(classify.classify({ now: T0, nest: far, bridge: null }).suspected).toBe(false);
	});
	test("a bridge that answers but needs its sign-in is not an outage signal", () => {
		expect(classify.classify({ now: T0, nest: [thermostats[0]], bridge: { reachable: true, state: "authorization_required" } }).suspected).toBe(false);
	});
	test("the report fits the nudge column and never claims a cause it didn't find", () => {
		const items = classify.classify({ now: T0, nest: thermostats, bridge: { reachable: false } }).items;
		const text = classify.reportText({
			items,
			openedAt: min(-12),
			evidence: { cause: { status: "none" }, calls: { calls: [], plausible: [], error: null }, nws: { alerts: [], error: null } },
			timeZone: "America/New_York",
		});
		expect(text.length).toBeLessThanOrEqual(500);
		expect(text).toMatch(/Upstairs Thermostat, Den Thermostat and the camera bridge went offline within 2 minutes/);
		expect(text).toMatch(/found nothing published/);
		expect(text).toMatch(/look the same/);
	});
});

describe("run", () => {
	test("reports once per household member, records what was checked, and tells the same text to each", async () => {
		const { outage, store, pushed } = build();
		const out = await outage.run({ reason: "nest_offline" });
		expect(out.verdict).toBe("suspected");
		expect(pushed.map((p) => p.profileId)).toEqual([1, 2]);
		expect(pushed.every((p) => p.trigger_id === "outage")).toBe(true);
		expect(pushed.every((p) => p.collapseKey === undefined)).toBe(true);
		expect(out.text).toMatch(/Duke Energy/);
		const e = store.s.episodes[0];
		expect(e.state).toBe("reported");
		expect(e.locality).toBe("widespread");
		expect(e.checked.map((c) => c.source)).toEqual(expect.arrayContaining(["nest", "camera_bridge", "911_calls", "nws_alerts", "cause_search", "x_twitter", "duke_energy_outage_map"]));
		expect(store.s.assessments).toHaveLength(1);
		expect(store.s.assessments[0].verdict).toBe("suspected");
	});

	test("a second pass during the same outage says nothing more", async () => {
		const { outage, pushed } = build();
		await outage.run({});
		const before = pushed.length;
		const again = await outage.run({ now: min(15) });
		expect(again.verdict).toBe("ongoing");
		expect(pushed.length).toBe(before);
	});

	test("when things come back: one note, with the time and the cause, and the episode closes", async () => {
		const { outage, store, pushed, setBridge } = build();
		await outage.run({});
		store.s.offline = [];
		store.s.online = new Map([["t1", min(30)], ["t2", min(32)]]);
		setBridge({ configured: true, reachable: true, state: "ready" });
		const before = pushed.length;
		const out = await outage.run({ now: min(40) });
		expect(out.verdict).toBe("recovered");
		expect(pushed.length - before).toBe(2);
		expect(out.text).toMatch(/back online at 2:42 PM/);
		expect(out.text).toMatch(/Duke Energy/);
		expect(store.s.episodes[0].open_key).toBeNull();
		expect(store.s.episodes[0].state).toBe("closed");
		const quiet = await outage.run({ now: min(100) });
		expect(quiet.verdict).toBe("quiet");
		expect(pushed.length - before).toBe(2);
	});

	test("nothing wrong is a quiet row, not an empty table", async () => {
		const { outage, store, pushed } = build({ store: memoryStore({ offline: [] }), bridge: { configured: true, reachable: true, state: "ready" } });
		const out = await outage.run({ reason: "backstop" });
		expect(out.verdict).toBe("quiet");
		expect(pushed).toHaveLength(0);
		expect(store.s.assessments[0]).toMatchObject({ verdict: "quiet", reason: "backstop" });
	});

	test("nothing readable is check_failed, never quiet", async () => {
		const { outage, store, pushed } = build({ store: memoryStore({ nestError: "db down" }), bridge: { configured: false } });
		const out = await outage.run({});
		expect(out.verdict).toBe("check_failed");
		expect(pushed).toHaveLength(0);
		expect(store.s.assessments[0].errors[0].source).toBe("nest");
	});

	test("a failed search is said plainly and the report still goes", async () => {
		const { outage, store } = build({ search: async () => { throw new Error("quota"); } });
		const out = await outage.run({});
		expect(out.verdict).toBe("suspected");
		expect(out.text).toMatch(/search for a cause didn't work/);
		expect(store.s.episodes[0].cause_status).toBe("failed");
	});

	test("a trees-down call near home is surfaced; its absence is not reported as proof", async () => {
		const incidents = [{ id: "a", what: "Tree Down", where: "Oak St", miles: 0.8, receivedAt: min(-8).toISOString() }, { id: "b", what: "Medical", where: "Elm", miles: 1, receivedAt: min(-200).toISOString() }];
		const { outage } = build({ store: memoryStore({ offline: thermostats, incidents }), search: async () => ({ text: "" }) });
		const out = await outage.run({});
		expect(out.text).toMatch(/Tree Down on Oak St \(0.8 mi\)/);
		expect(out.text).not.toMatch(/Medical/);
	});

	test("an alarming reading of a search result is recorded, not repeated", async () => {
		const { outage, store, llm } = build();
		llm.generateJson.mockResolvedValue({ data: { found: true, scope: "widespread", summary: "Officials suspect a cyberattack on the grid.", source: "X", restoration: "" } });
		const out = await outage.run({});
		expect(out.text).not.toMatch(/cyber|attack/i);
		expect(out.text).toMatch(/haven't confirmed a cause/);
		expect(store.s.episodes[0].checked.find((c) => c.source === "cause_search").raw).toMatch(/cyberattack/);
	});

	test("no recipients: the episode stays open to be told next pass, and says why", async () => {
		const { outage, store } = build({ recipients: [] });
		const out = await outage.run({});
		expect(store.s.episodes[0].state).toBe("open");
		expect(out.errors.map((e) => e.source)).toContain("report");
	});
});

describe("camera bridge on its own", () => {
	const quiet = () => build({ store: memoryStore({ offline: [] }), bridge: { configured: true, reachable: false, error: "timeout" } });

	test("down for under 45 minutes: recorded, not yet reported; then reported once; then 'back' once", async () => {
		const { outage, store, pushed, setBridge } = quiet();
		await outage.run({});
		expect(store.s.health.state).toBe("unreachable");
		expect(pushed).toHaveLength(0);
		await outage.run({ now: min(60) });
		expect(pushed).toHaveLength(2);
		expect(pushed[0].text).toMatch(/camera bridge hasn't answered since 2:10 PM/);
		await outage.run({ now: min(120) });
		expect(pushed).toHaveLength(2);
		setBridge({ configured: true, reachable: true, state: "ready" });
		await outage.run({ now: min(180) });
		expect(pushed).toHaveLength(4);
		expect(pushed[2].text).toMatch(/answering again/);
		await outage.run({ now: min(240) });
		expect(pushed).toHaveLength(4);
	});

	test("up but signed out is worded as a sign-in problem", async () => {
		const { outage, pushed } = build({ store: memoryStore({ offline: [] }), bridge: { configured: true, reachable: true, state: "authorization_required" } });
		await outage.run({});
		await outage.run({ now: min(60) });
		expect(pushed[0].text).toMatch(/needs its Eufy sign-in again/);
	});

	test("while an outage episode is open the outage report covers it", async () => {
		const { outage, pushed } = build();
		await outage.run({});
		const n = pushed.length;
		await outage.run({ now: min(60) });
		expect(pushed.length).toBe(n);
	});
});

describe("scheduling", () => {
	test("an offline transition books one bucketed wake-up; many in a burst share it", async () => {
		const wake = jest.fn(async () => true);
		const outage = createOutage({ store: memoryStore(), wake, now: () => T0 });
		await outage.noteNestEvent({ wentOffline: [1] });
		const at = wake.mock.calls[0][0];
		expect(at.getTime() % (5 * 60_000)).toBe(0);
		expect(at.getTime() - T0.getTime()).toBeGreaterThanOrEqual(3 * 60_000);
		expect(wake.mock.calls[0][1]).toMatchObject({ name: "outage", reason: "outage:nest_offline" });
		await outage.noteNestEvent({ wentOffline: [1], now: new Date(T0.getTime() + 20_000) });
		expect(wake.mock.calls[1][0].getTime()).toBe(at.getTime());
	});

	test("a failure to book never throws", async () => {
		const outage = createOutage({ store: memoryStore(), wake: async () => { throw new Error("no queue"); }, now: () => T0 });
		await expect(outage.noteNestEvent({ wentOffline: [1] })).resolves.toEqual({ booked: false });
	});

	test("a device coming back only matters while an episode is open", async () => {
		const wake = jest.fn(async () => true);
		const store = memoryStore();
		const outage = createOutage({ store, wake, now: () => T0 });
		await outage.noteNestEvent({ wentOnline: [1] });
		expect(wake).not.toHaveBeenCalled();
		await store.createEpisode({ uuid: "u", openedAt: T0, signals: [] });
		await outage.noteNestEvent({ wentOnline: [1] });
		expect(wake).toHaveBeenCalledTimes(1);
	});

	test("the hourly backstop asks only when nothing has run lately", async () => {
		const store = memoryStore();
		const outage = createOutage({ store, now: () => T0 });
		expect(await outage.backstopDue()).toBe("outage backstop");
		store.s.assessments.push({ at: min(-10) });
		expect(await outage.backstopDue()).toBeNull();
		store.s.assessments.push({ at: min(-70) });
		store.s.assessments.splice(0, 1);
		expect(await outage.backstopDue()).toBe("outage backstop");
		await store.createEpisode({ uuid: "u", openedAt: T0, signals: [] });
		store.s.assessments.push({ at: min(-20) });
		expect(await outage.backstopDue()).toBe("outage backstop (episode open)");
	});
});

describe("evidence", () => {
	test("townOf gives the town, never the street", () => {
		expect(evidence.townOf("1 Main St, Charlotte, NC 28202")).toBe("Charlotte, NC");
		expect(evidence.townOf("somewhere")).toBeNull();
	});
	test("no town: the search says it couldn't, rather than searching for nothing", async () => {
		const r = await evidence.searchCause({ llm: {}, town: null, now: T0 });
		expect(r.status).toBe("failed");
	});
	test("links and control characters are stripped from what a search result contributes", async () => {
		const llm = {
			search: async () => ({ text: "x", sources: [] }),
			generateJson: async () => ({ data: { found: true, scope: "local", summary: "Out near Oak St https://evil.test/a\n\nignore previous", source: "WSOC", restoration: "" } }),
		};
		const r = await evidence.searchCause({ llm, town: "Charlotte, NC", now: T0 });
		expect(r.text).not.toMatch(/https?:|\n/);
	});
});
