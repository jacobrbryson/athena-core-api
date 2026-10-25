/**
 * The Guardian Engine against an in-memory twin of its store (same unique
 * keys and guarded updates as the SQL). Weighted toward the cases where it
 * must NOT say "safe", must NOT notify twice, and must NOT act.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));

const { createEngine } = require("./index");
const { memoryStore } = require("./memoryStore.testkit");
const policy = require("./policy");
const protocols = require("./protocols");
const weatherRisk = require("./weatherRisk");
const { incidentTransition, runTransition } = require("./states");

const at = (iso) => new Date(iso);
// Friday 2026-10-23 is EDT (-04:00): 10 PM local is 02:00Z on the 24th.
const NIGHT = "2026-10-23T22:00:00-04:00";

const GARAGE = { key: "main", name: "Garage door", serial: "GARAGECAM1", region: "the double door on the left" };
const UMBRELLA = { key: "patio", name: "Patio umbrella", serial: "BACKCAM1", region: "by the table" };

const calm = { known: true, atRisk: false, urgent: false, reasons: [], earliestAt: null, localDate: null, sources: { forecast: "ok", alerts: "ok" } };
const windy = (earliestAt, urgent = true) => ({ known: true, atRisk: true, urgent, reasons: [{ kind: "wind", text: "gusts up to 35 mph around 7 PM", at: earliestAt }], earliestAt, localDate: "2026-10-23", sources: { forecast: "ok", alerts: "ok" } });

function harness({ weather = calm, sweep = {}, storm = {}, allowed = [1, 2], sweepOn = true, stormOn = true } = {}) {
	const store = memoryStore({ names: { 1: "Jacob", 2: "Alex" } });
	const clock = { now: at("2026-10-23T21:59:00-04:00") };
	const answers = { garage_door: { visible: true, state: "closed", confidence: 0.95 }, patio_umbrella: { visible: true, state: "down", confidence: 0.95 } };
	const deliveries = [];
	const pushResult = { value: { sent: 1, failed: 0 } };
	const deps = {
		store,
		now: () => new Date(clock.now.getTime()),
		allowedIds: () => allowed,
		push: () => ({ deliverNudge: async (profileId, nudge) => (deliveries.push({ profileId, ...nudge }), typeof pushResult.value === "function" ? pushResult.value(profileId) : pushResult.value) }),
		weather: jest.fn(async () => (typeof weather === "function" ? weather() : weather)),
		tonight: jest.fn(async () => ({ known: true, calm: true, phrase: null })),
		homePlace: async () => ({ latitude: 35.6, longitude: -80.9 }),
		cameraNames: async () => new Map([["GARAGECAM1", "Garage"], ["BACKCAM1", "Backyard"]]),
		saveEvidence: jest.fn(async () => "evidence-uuid"),
		removeEvidence: jest.fn(),
		asProfile: (id, fn) => fn(),
		wake: jest.fn(async () => true),
		sleep: async () => {},
		observeDeps: {
			snapshot: jest.fn(async () => ({ ok: true, jpeg: Buffer.from("jpeg"), capturedAt: new Date(clock.now.getTime()), latencyMs: 5 })),
			vision: jest.fn(async ({ check }) => (typeof answers[check.id] === "function" ? answers[check.id]() : answers[check.id])),
			sensors: jest.fn(async () => []),
		},
	};
	const engine = createEngine(deps);
	const save = (id, enabled, config) => store.saveProtocol(1, id, { version: 1, enabled, config: protocols.normalizeConfig(id, config), updatedBy: 1, now: clock.now });
	const ready = Promise.all([
		// The alert-path tests run the sweep at 10 PM without reports; the report tests turn them on.
		save("nightly_sweep", sweepOn, { garageDoors: [GARAGE], schedule: { time: "22:00", timeZone: "America/New_York" }, reports: { evening: false, morning: false }, ...sweep }),
		save("storm_umbrella", stormOn, { umbrella: UMBRELLA, ...storm }),
	]);
	const advance = (iso) => (clock.now = at(iso));
	return { store, clock, answers, deliveries, pushResult, deps, engine, ready, advance, db: store.db };
}

const incidentsOf = (h) => h.db.incidents;
const notesOf = (h, kind) => h.db.notes.filter((n) => !kind || n.kind === kind);

describe("nightly sweep — garage door", () => {
	test("1. confirmed closed: logs the verification and stays silent", async () => {
		const h = harness();
		await h.ready;
		const planned = await h.engine.plan();
		expect(planned.scheduled).toHaveLength(1);
		expect(h.deps.wake).toHaveBeenCalledWith(at(NIGHT));
		expect(h.db.runs[0].scheduled_for.toISOString()).toBe("2026-10-24T02:00:00.000Z");
		h.advance("2026-10-23T22:00:05-04:00");
		const out = await h.engine.runDue();
		expect(out.ran).toEqual([expect.objectContaining({ protocol: "nightly_sweep", state: "safe" })]);
		const garage = h.db.obs.find((o) => o.check_id === "garage_door");
		expect(garage).toMatchObject({ status: "closed", fresh: 1, confidence: 0.95, evidence_media_uuid: null });
		expect(new Date(garage.captured_at).toISOString()).toBe(at("2026-10-23T22:00:05-04:00").toISOString());
		expect(incidentsOf(h)).toHaveLength(0);
		expect(h.deliveries).toHaveLength(0);
		// A safe frame is not kept.
		expect(h.deps.saveEvidence).not.toHaveBeenCalled();
	});

	test("2. confirmed open: alerts every approved adult once, with evidence kept", async () => {
		const h = harness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.92 };
		await h.engine.plan();
		h.advance("2026-10-23T22:00:05-04:00");
		const out = await h.engine.runDue();
		expect(out.ran[0].state).toBe("notified");
		expect(incidentsOf(h)).toHaveLength(1);
		expect(incidentsOf(h)[0]).toMatchObject({ state: "notified", condition_status: "open", severity: "urgent", open_key: "garage_door:main" });
		expect(h.deliveries.map((d) => d.profileId).sort()).toEqual([1, 2]);
		expect(h.deliveries[0].text).toMatch(/lights out.*garage door appears to be open.*Garage camera just now.*Can someone close it\?/);
		expect(h.db.nudges).toHaveLength(2);
		expect(h.db.obs.find((o) => o.check_id === "garage_door").evidence_media_uuid).toBe("evidence-uuid");
	});

	test("3a. partially open is open — a door a foot up is not closed", async () => {
		const h = harness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "partially_open", confidence: 0.88 };
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(incidentsOf(h)[0].condition_status).toBe("open");
	});

	test("3b. visually ambiguous: retries with fresh frames, then reports it can't verify", async () => {
		const h = harness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "closed", confidence: 0.55 };
		h.advance(NIGHT);
		const out = await h.engine.runDue();
		const garageShots = h.deps.observeDeps.snapshot.mock.calls.filter(([s]) => s === "GARAGECAM1");
		expect(garageShots).toHaveLength(3); // first look + two retries, each a fresh capture
		expect(out.ran[0].state).toBe("notified");
		expect(incidentsOf(h)[0]).toMatchObject({ condition_status: "unknown" });
		expect(h.deliveries[0].text).toMatch(/couldn't verify whether the garage door is closed because the picture wasn't clear enough/);
		expect(h.db.obs.filter((o) => o.check_id === "garage_door").map((o) => o.status)).toEqual(["unknown", "unknown", "unknown"]);
	});

	test("3c. partially visible (door out of frame) is unknown, never closed", async () => {
		const h = harness();
		await h.ready;
		h.answers.garage_door = { visible: false, state: "closed", confidence: 0.99 };
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(h.db.obs.find((o) => o.check_id === "garage_door")).toMatchObject({ status: "unknown", reason: "not_visible" });
		expect(h.deliveries[0].text).toMatch(/isn't visible in the camera's view/);
	});

	test("4. camera offline: reports verification unavailable, never assumes closed", async () => {
		const h = harness();
		await h.ready;
		h.deps.observeDeps.snapshot.mockImplementation(async () => ({ ok: false, reason: "device_unavailable" }));
		h.advance(NIGHT);
		await h.engine.runDue();
		const obs = h.db.obs.filter((o) => o.check_id === "garage_door");
		expect(obs.every((o) => o.status === "offline" && !o.fresh)).toBe(true);
		expect(incidentsOf(h)[0].condition_status).toBe("offline");
		expect(h.deliveries[0].text).toMatch(/couldn't verify whether the garage door is closed because the camera isn't responding/);
		expect(h.deps.observeDeps.vision).not.toHaveBeenCalledWith(expect.objectContaining({ check: expect.objectContaining({ id: "garage_door" }) }));
	});

	test("5a. a stale snapshot is never evidence of current safety", async () => {
		const h = harness();
		await h.ready;
		h.deps.observeDeps.snapshot.mockImplementation(async () => ({ ok: true, jpeg: Buffer.from("old"), capturedAt: new Date(h.clock.now.getTime() - 10 * 60_000) }));
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(h.db.obs.find((o) => o.check_id === "garage_door")).toMatchObject({ status: "unknown", reason: "stale", fresh: 0 });
		expect(h.deps.observeDeps.vision).not.toHaveBeenCalled();
		expect(incidentsOf(h)[0].condition_status).toBe("unknown");
	});

	test("5b. a frame that went stale while the model was thinking doesn't count either", async () => {
		const h = harness();
		await h.ready;
		h.advance(NIGHT);
		h.deps.observeDeps.vision.mockImplementation(async () => {
			h.clock.now = new Date(h.clock.now.getTime() + 3 * 60_000);
			return { visible: true, state: "closed", confidence: 0.99 };
		});
		await h.engine.runDue();
		expect(h.db.obs.find((o) => o.check_id === "garage_door")).toMatchObject({ status: "unknown", reason: "stale" });
	});
});

describe("umbrella and weather", () => {
	test("6. umbrella down and no storm risk: not even looked at on a calm night", async () => {
		const h = harness();
		await h.ready;
		const planned = await h.engine.plan();
		expect(planned.storm).toEqual({ atRisk: false, known: true, created: false });
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(h.deps.observeDeps.snapshot).not.toHaveBeenCalledWith("BACKCAM1");
		expect(h.db.obs.find((o) => o.check_id === "patio_umbrella")).toMatchObject({ status: "not_applicable" });
		expect(h.db.runs.filter((r) => r.protocol_id === "storm_umbrella")).toHaveLength(0);
	});

	test("7. umbrella up with high winds approaching: urgent alert naming the weather", async () => {
		const h = harness({ weather: windy("2026-10-23T19:00:00-04:00") });
		await h.ready;
		h.advance("2026-10-23T17:00:00-04:00");
		h.answers.patio_umbrella = { visible: true, state: "up", confidence: 0.9 };
		await h.engine.runDue();
		const incident = incidentsOf(h).find((i) => i.check_id === "patio_umbrella");
		expect(incident).toMatchObject({ severity: "urgent", condition_status: "up", trigger_kind: "weather" });
		expect(h.deliveries[0].text).toMatch(/There's gusts up to 35 mph around 7 PM, and the patio umbrella still appears to be open/);
		// It lapses once the weather has passed, rather than staying open forever.
		expect(new Date(incident.expires_at).toISOString()).toBe("2026-10-24T05:00:00.000Z");
	});

	test("8. storm detected before the nightly schedule: checked at 5 PM, not told again at 10", async () => {
		const h = harness({ weather: windy("2026-10-23T19:00:00-04:00") });
		await h.ready;
		h.answers.patio_umbrella = { visible: true, state: "up", confidence: 0.9 };
		h.advance("2026-10-23T17:00:00-04:00");
		await h.engine.runDue();
		const sweep = h.db.runs.find((r) => r.protocol_id === "nightly_sweep");
		expect(sweep.state).toBe("scheduled"); // the 10 PM sweep is untouched
		expect(notesOf(h, "alert")).toHaveLength(2);
		h.advance(NIGHT);
		await h.engine.runDue();
		const incident = incidentsOf(h).find((i) => i.check_id === "patio_umbrella");
		expect(new Date(incident.last_verified_at).toISOString()).toBe(at(NIGHT).toISOString());
		expect(notesOf(h, "alert")).toHaveLength(2);
		// One storm watch per day; the rest are the incident's own rechecks.
		expect(h.db.runs.filter((r) => r.protocol_id === "storm_umbrella" && r.trigger_kind === "weather")).toHaveLength(1);
	});

	test("9. umbrella not visible under storm risk: says so instead of guessing", async () => {
		const h = harness({ weather: windy("2026-10-23T19:00:00-04:00") });
		await h.ready;
		h.answers.patio_umbrella = { visible: false, state: "unknown", confidence: 0.2 };
		h.advance("2026-10-23T17:00:00-04:00");
		await h.engine.runDue();
		expect(incidentsOf(h)[0]).toMatchObject({ check_id: "patio_umbrella", condition_status: "unknown", severity: "advisory" });
		expect(h.deliveries[0].text).toMatch(/couldn't verify whether the patio umbrella is down because it isn't visible.*There's gusts up to 35 mph/);
	});

	test("an unreadable forecast is not calm: the sweep still looks at the umbrella", async () => {
		const h = harness({ weather: { ...calm, known: false, sources: { forecast: "unavailable", alerts: "unavailable" } } });
		await h.ready;
		h.answers.patio_umbrella = { visible: true, state: "up", confidence: 0.9 };
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(h.deps.observeDeps.snapshot).toHaveBeenCalledWith("BACKCAM1");
		expect(h.deliveries.find((d) => /umbrella/.test(d.text)).text).toMatch(/couldn't read the forecast/);
	});

	test("an advisory found in quiet hours is held until morning, not dropped", async () => {
		const h = harness({ weather: windy("2026-10-24T08:00:00-04:00", false) });
		await h.ready;
		h.answers.patio_umbrella = { visible: true, state: "up", confidence: 0.9 };
		h.advance("2026-10-23T23:00:00-04:00");
		await h.engine.runDue();
		expect(notesOf(h, "alert").map((n) => n.status)).toEqual(["held", "held"]);
		expect(new Date(notesOf(h, "alert")[0].hold_until).toISOString()).toBe("2026-10-24T11:00:00.000Z");
		expect(h.deliveries).toHaveLength(0);
		h.advance("2026-10-24T07:01:00-04:00");
		await h.engine.plan();
		expect(notesOf(h, "alert").map((n) => n.status)).toEqual(["sent", "sent"]);
	});
});

describe("weatherRisk.assess", () => {
	const hourAt = (h, extra) => ({ start: `2026-10-23T${String(h).padStart(2, "0")}:00:00-04:00`, windMph: 8, precipitationChance: 10, shortForecast: "Partly Cloudy", ...extra });
	const now = at("2026-10-23T16:00:00-04:00");
	test("gusts at or over the threshold inside the lookahead are a risk", async () => {
		const hours = [hourAt(16), hourAt(19, { windMph: 32 }), hourAt(23, { windMph: 50 })];
		const r = await weatherRisk.assess({ latitude: 1, longitude: 1 }, {}, { now, read: { hourly: async () => ({ hours }), alerts: async () => [] } });
		expect(r).toMatchObject({ known: true, atRisk: true, urgent: true, localDate: "2026-10-23" });
		expect(r.reasons[0].text).toBe("gusts up to 32 mph around 7 PM");
	});
	test("an NWS thunderstorm warning counts on its own", async () => {
		const r = await weatherRisk.assess({ latitude: 1, longitude: 1 }, {}, { now, read: { hourly: async () => null, alerts: async () => [{ id: "a", event: "Severe Thunderstorm Warning", onset: "2026-10-23T16:30:00-04:00" }] } });
		expect(r).toMatchObject({ known: true, atRisk: true });
		expect(weatherRisk.phrase(r)).toBe("a Severe Thunderstorm Warning");
	});
	test("no answer from either source is unknown, not calm", async () => {
		const r = await weatherRisk.assess({ latitude: 1, longitude: 1 }, {}, { now, read: { hourly: async () => { throw new Error("down"); }, alerts: async () => { throw new Error("down"); } } });
		expect(r).toMatchObject({ known: false, atRisk: false });
	});
});

describe("idempotency and follow-through", () => {
	test("10. duplicate scheduled execution: one run, one claim, one look", async () => {
		const h = harness();
		await h.ready;
		await h.engine.plan();
		await h.engine.plan();
		expect(h.db.runs.filter((r) => r.protocol_id === "nightly_sweep")).toHaveLength(1);
		h.advance(NIGHT);
		const [a, b] = await Promise.all([h.engine.runDue(), h.engine.runDue()]);
		expect(a.ran.length + b.ran.length).toBe(1);
		expect(h.deps.observeDeps.snapshot.mock.calls.filter(([s]) => s === "GARAGECAM1")).toHaveLength(1);
	});

	test("11. the same unresolved issue seen again: rechecked, never re-alerted", async () => {
		const h = harness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(h.deliveries).toHaveLength(2);
		h.advance("2026-10-23T22:16:00-04:00");
		await h.engine.runDue();
		h.advance("2026-10-23T22:32:00-04:00");
		await h.engine.runDue();
		const incident = incidentsOf(h)[0];
		expect(incident.recheck_count).toBe(2);
		expect(new Date(incident.last_verified_at).toISOString()).toBe(at("2026-10-23T22:32:00-04:00").toISOString());
		expect(incidentsOf(h)).toHaveLength(1);
		// Two alerts at 10:00, then one escalation at 10:32 because nobody acknowledged — nothing else.
		expect(notesOf(h, "alert")).toHaveLength(2);
		expect(notesOf(h, "escalation")).toHaveLength(2);
		h.advance("2026-10-23T22:48:00-04:00");
		await h.engine.runDue();
		expect(notesOf(h, "escalation")).toHaveLength(2);
	});

	test("12. acknowledged is not resolved: rechecks continue and the door is still open", async () => {
		const h = harness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.advance(NIGHT);
		await h.engine.runDue();
		const uuid = incidentsOf(h)[0].uuid;
		await h.engine.acknowledge(2, uuid);
		expect(incidentsOf(h)[0]).toMatchObject({ state: "acknowledged", acknowledged_by: 2, open_key: "garage_door:main", resolved_at: null });
		h.advance("2026-10-23T22:40:00-04:00");
		await h.engine.runDue();
		expect(incidentsOf(h)[0].state).toBe("acknowledged");
		expect(notesOf(h, "escalation")).toHaveLength(0); // acknowledged stops the escalation
		expect(() => incidentTransition("acknowledged", "open")).toThrow(/illegal/);
	});

	test("13. resolution after reinspection: fresh evidence closes it and the alerted hear so", async () => {
		const h = harness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.advance(NIGHT);
		await h.engine.runDue();
		h.answers.garage_door = { visible: true, state: "closed", confidence: 0.97 };
		h.advance("2026-10-23T22:16:00-04:00");
		await h.engine.runDue();
		expect(incidentsOf(h)[0]).toMatchObject({ state: "resolved", resolution: "verified_safe", open_key: null });
		expect(notesOf(h, "resolved").map((n) => n.profile_id).sort()).toEqual([1, 2]);
		expect(h.deliveries.at(-1).text).toMatch(/garage door is closed now — I checked the Garage camera at 10:16 PM/);
		// A new opening later is a new incident.
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		await h.engine.recheck(1, incidentsOf(h)[0].uuid).catch((e) => expect(e.status).toBe(409));
		await h.engine.runNow(1, "nightly_sweep");
		expect(incidentsOf(h)).toHaveLength(2);
	});

	test("14. notification delivery failure: recorded, retried, and stops after three tries", async () => {
		const h = harness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.pushResult.value = (profileId) => (profileId === 1 ? { sent: 0, failed: 1 } : { sent: 1, failed: 0 });
		h.advance(NIGHT);
		await h.engine.runDue();
		const failed = () => h.db.notes.find((n) => n.profile_id === 1 && n.kind === "alert");
		expect(failed()).toMatchObject({ status: "failed", attempts: 1 });
		expect(h.db.events.some((e) => e.kind === "notification_failed")).toBe(true);
		// The in-app half still exists for that person.
		expect(h.db.nudges.some((n) => n.profileId === 1)).toBe(true);
		h.advance("2026-10-23T22:05:00-04:00");
		await h.engine.plan();
		await h.engine.plan();
		expect(failed()).toMatchObject({ status: "failed", attempts: 3 });
		await h.engine.plan();
		expect(failed().attempts).toBe(3);
		h.pushResult.value = { sent: 1, failed: 0 };
		await h.engine.plan();
		expect(failed().attempts).toBe(3); // out of tries; the dashboard shows it
	});

	test("a person with push off still gets the alert in the app, and it isn't retried", async () => {
		const h = harness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.pushResult.value = { sent: 0, failed: 0, devices: 0, skipped: "not enabled" };
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(notesOf(h, "alert").map((n) => n.status)).toEqual(["in_app", "in_app"]);
	});

	test("16. a restart during an active incident loses nothing", async () => {
		const h = harness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.advance(NIGHT);
		await h.engine.runDue();
		// A recheck run is claimed, then the process dies mid-observation.
		h.advance("2026-10-23T22:16:00-04:00");
		await h.engine.plan();
		const recheck = h.db.runs.find((r) => r.trigger_kind === "recheck");
		expect(await h.store.claimRun(recheck.id, { now: h.clock.now, leaseMs: 4 * 60_000, maxAttempts: 3 })).toBe(true);
		// A new process, same database.
		const again = createEngine({ ...h.deps });
		h.advance("2026-10-23T22:18:00-04:00");
		expect((await again.runDue()).ran).toHaveLength(0); // lease still held
		h.advance("2026-10-23T22:21:00-04:00");
		const out = await again.runDue();
		expect(out.ran).toEqual([expect.objectContaining({ state: "attention_required" })]);
		expect(h.db.runs.find((r) => r.id === recheck.id).attempts).toBe(2);
		expect(incidentsOf(h)).toHaveLength(1);
		expect(incidentsOf(h)[0].state).toBe("notified");
		expect(notesOf(h, "alert")).toHaveLength(2);
	});

	test("a sweep the service never ran is reported, not silent", async () => {
		const h = harness();
		await h.ready;
		await h.engine.plan();
		h.advance("2026-10-23T22:16:00-04:00");
		await h.engine.plan(); // the job: it can plan but not observe
		const sweep = h.db.runs.find((r) => r.occurrence_key === "2026-10-23");
		expect(sweep.state).toBe("notified");
		expect(sweep.summary).toMatchObject({ missed: true, reason: "dispatch_unavailable" });
		expect(incidentsOf(h)[0]).toMatchObject({ check_id: "garage_door", condition_status: "unknown" });
		expect(h.deliveries[0].text).toMatch(/the check didn't run — I couldn't reach the cameras at sweep time/);
		// Tomorrow's is already booked.
		expect(h.db.runs.some((r) => r.occurrence_key === "2026-10-24")).toBe(true);
	});

	test("17. camera and sensor disagree: unknown, and said plainly", async () => {
		const h = harness();
		await h.ready;
		h.deps.observeDeps.sensors.mockImplementation(async (check) => (check.id === "garage_door" ? [{ status: "open", fresh: true, confidence: 0.99, capturedAt: h.clock.now }] : []));
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(h.db.obs.find((o) => o.check_id === "garage_door")).toMatchObject({ status: "unknown", reason: "conflict", source: "fused" });
		expect(h.deliveries[0].text).toMatch(/the camera and the sensor disagree/);
	});

	test("17b. a sensor that agrees corroborates; one alone covers a camera that couldn't tell", async () => {
		const h = harness();
		await h.ready;
		h.deps.observeDeps.sensors.mockImplementation(async () => [{ status: "closed", fresh: true, confidence: 0.99, capturedAt: h.clock.now }]);
		h.answers.garage_door = { visible: true, state: "closed", confidence: 0.8 };
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(h.db.obs.find((o) => o.check_id === "garage_door")).toMatchObject({ status: "closed", source: "fused", confidence: 0.99 });
		expect(incidentsOf(h)).toHaveLength(0);
	});
});

describe("policy and permissions", () => {
	test("15. an unauthorized action is refused, audited, and never executed", async () => {
		const h = harness();
		await h.ready;
		const close = await h.engine.requestAction("device.garage_close", { requestedBy: "model" });
		expect(close).toMatchObject({ allowed: false, level: 3, executed: false });
		expect(close.reasons.join(" ")).toMatch(/physical security actions need a person's approval/);
		expect((await h.engine.requestAction("security.change_permissions")).level).toBe(4);
		expect((await h.engine.requestAction("media.share_external")).allowed).toBe(false);
		expect((await h.engine.requestAction("delete_everything")).allowed).toBe(false);
		expect(h.db.audits.map((a) => a.action)).toEqual(expect.arrayContaining(["guardian_refused:device.garage_close", "guardian_refused:security.change_permissions"]));
	});

	test("hard rules beat the score and configuration can only tighten", () => {
		// A configured "allow" can't loosen a physical action.
		expect(policy.authorize("device.garage_close", { restrict: { "device.garage_close": 2 } }).allowed).toBe(false);
		// Configured observe-only turns notifications off.
		expect(policy.authorize("notify.household", { restrict: { "notify.household": 0 } })).toMatchObject({ allowed: false, restricted: true });
		// A recipient outside the household is an external message.
		expect(policy.authorize("notify.household", { recipientApproved: false }).allowed).toBe(false);
		expect(policy.authorize("camera.fresh_snapshot")).toMatchObject({ allowed: true, level: 1, notify: false });
		expect(policy.authorize("notify.household")).toMatchObject({ allowed: true, level: 2, notify: true });
		expect(policy.normalizeRestrictions({ "notify.household": 0, "made.up": 1, "camera.status": "x" })).toEqual({ "notify.household": 0 });
	});

	test("observe-only configuration records the incident and sends nothing", async () => {
		const h = harness({ sweep: { autonomy: { "notify.household": 0 } } });
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(incidentsOf(h)).toHaveLength(1);
		expect(h.deliveries).toHaveLength(0);
		expect(h.db.events.some((e) => e.kind === "policy_refused" && e.detail.actionId === "notify.household")).toBe(true);
	});

	test("18a. recipients are only ever approved household adults", async () => {
		const h = harness();
		await h.ready;
		await expect(h.engine.saveConfig(1, "nightly_sweep", { enabled: true, config: { garageDoors: [GARAGE], recipients: ["1", "99"] } })).rejects.toMatchObject({ status: 403 });
		expect(h.db.audits.some((a) => a.action === "guardian_refused:notify.external")).toBe(true);
		// Even a stored config naming an outsider (written before an allowlist change) reaches only approved adults.
		h.db.protocols.find((p) => p.protocol_id === "nightly_sweep").config.recipients = ["2", "99"];
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(h.deliveries.map((d) => d.profileId)).toEqual([2]);
	});

	test("18b. incidents are scoped to the household", async () => {
		const h = harness();
		await h.ready;
		h.db.incidents.push({ id: 500, uuid: "11111111-1111-4111-8111-111111111111", household_id: 2, state: "open", open_key: "garage_door:x" });
		await expect(h.engine.acknowledge(1, "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({ status: 404 });
		await expect(h.engine.assign(1, "11111111-1111-4111-8111-111111111111", 1)).rejects.toMatchObject({ status: 404 });
	});

	test("dismissing needs a reason and closes the incident; assignment only to approved adults", async () => {
		const h = harness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.advance(NIGHT);
		await h.engine.runDue();
		const uuid = incidentsOf(h)[0].uuid;
		await expect(h.engine.assign(1, uuid, 99)).rejects.toMatchObject({ status: 403 });
		await h.engine.assign(1, uuid, 2);
		await expect(h.engine.dismiss(1, uuid, "")).rejects.toMatchObject({ status: 400 });
		await h.engine.dismiss(1, uuid, "Door is open for the painters");
		expect(incidentsOf(h)[0]).toMatchObject({ state: "dismissed", resolution: "dismissed", dismissed_by: 1, open_key: null, assigned_profile_id: 2 });
	});
});

describe("simulation", () => {
	test("a scripted scenario runs the whole protocol and sends nothing", async () => {
		const h = harness();
		await h.ready;
		h.advance("2026-10-23T15:00:00-04:00");
		const out = await h.engine.runNow(1, "nightly_sweep", { scenario: { garage_door: { main: "open" } } });
		expect(out.state).toBe("notified");
		expect(notesOf(h, "alert").map((n) => n.status)).toEqual(["simulated", "simulated"]);
		expect(h.deliveries).toHaveLength(0);
		expect(h.deps.saveEvidence).not.toHaveBeenCalled();
		expect(h.deps.observeDeps.snapshot).not.toHaveBeenCalled();
		expect(h.db.runs.find((r) => r.trigger_kind === "manual").simulated).toBe(1);
		// A test leaves nothing open, and can never stand in for a real incident.
		expect(incidentsOf(h)[0]).toMatchObject({ state: "dismissed", open_key: null, next_recheck_at: null });
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(incidentsOf(h).filter((i) => i.state === "notified")).toHaveLength(1);
		expect(h.deliveries).toHaveLength(2);
	});

	test("a protocol in simulation mode never pushes", async () => {
		const h = harness({ sweep: { simulation: true } });
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.advance(NIGHT);
		await h.engine.runDue();
		expect(notesOf(h, "alert").every((n) => n.status === "simulated")).toBe(true);
		expect(h.deliveries).toHaveLength(0);
	});
});

describe("evening and morning reports", () => {
	const EVENING = "2026-10-23T21:00:05-04:00";
	const REPORTS = { schedule: { time: "21:00", timeZone: "America/New_York" }, reports: { evening: true, morning: true, morningTime: "06:00" } };
	const reportHarness = (opts = {}) => harness({ ...opts, sweep: { ...REPORTS, ...(opts.sweep || {}) } });
	const evening = async (h) => {
		h.advance("2026-10-23T20:59:00-04:00");
		await h.engine.plan();
		h.advance(EVENING);
		return h.engine.runDue();
	};

	test("all clear at 9 PM: one push each, after really looking at the doors and the umbrella", async () => {
		const h = reportHarness();
		await h.ready;
		await evening(h);
		expect(h.deps.observeDeps.snapshot).toHaveBeenCalledWith("BACKCAM1"); // looked, though the night is calm
		expect(h.deliveries.map((d) => d.profileId).sort()).toEqual([1, 2]);
		expect(h.deliveries[0].text).toBe("All clear — I checked the garage door and the patio umbrella, and the weather looks peaceful tonight.");
		expect(incidentsOf(h)).toHaveLength(0);
		expect(h.db.runs.find((r) => r.occurrence_key === "2026-10-23").summary.report).toMatchObject({ kind: "evening" });
	});

	test("all clear, but the forecast isn't peaceful", async () => {
		const h = reportHarness();
		await h.ready;
		h.deps.tonight.mockResolvedValue({ known: true, calm: false, phrase: "possible snow storms from around 11 PM" });
		await evening(h);
		expect(h.deliveries[0].text).toBe("All clear — I checked the garage door and the patio umbrella, but there's possible snow storms from around 11 PM tonight.");
	});

	test("problems go out as ONE alert report, and still open incidents that escalate and recheck", async () => {
		const h = reportHarness({ weather: windy("2026-10-23T23:00:00-04:00") });
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.answers.patio_umbrella = { visible: true, state: "up", confidence: 0.9 };
		await evening(h);
		// Two problems, two people: two pushes, not six.
		expect(h.deliveries).toHaveLength(2);
		expect(h.deliveries[0].text).toBe("ALERT: Your garage door is still open and the patio umbrella needs to be brought down before gusts up to 35 mph around 7 PM.");
		expect(incidentsOf(h).map((i) => i.state)).toEqual(["notified", "notified"]);
		expect(notesOf(h, "alert").map((n) => n.status)).toEqual(["sent", "sent", "sent", "sent"]);
		// The incidents behave like any other: one reminder if no one acknowledges.
		h.advance("2026-10-23T21:31:00-04:00");
		await h.engine.plan();
		expect(notesOf(h, "escalation").length).toBeGreaterThan(0);
	});

	test("an umbrella left up on a calm night is mentioned, not alarmed about", async () => {
		const h = reportHarness();
		await h.ready;
		h.answers.patio_umbrella = { visible: true, state: "up", confidence: 0.9 };
		const out = await evening(h);
		expect(out.ran[0].state).toBe("safe");
		expect(h.deliveries[0].text).toMatch(/^All clear .* peaceful tonight\. The patio umbrella is up, but the night looks calm\.$/);
		expect(incidentsOf(h)).toHaveLength(0);
	});

	test("a door it couldn't verify is a heads-up, never 'all clear'", async () => {
		const h = reportHarness();
		await h.ready;
		h.deps.observeDeps.snapshot.mockImplementation(async (serial) => (serial === "GARAGECAM1" ? { ok: false, reason: "device_unavailable" } : { ok: true, jpeg: Buffer.from("x"), capturedAt: new Date(h.clock.now.getTime()) }));
		await evening(h);
		expect(h.deliveries[0].text).toMatch(/^Heads up: I couldn't verify the garage door — the camera isn't responding\. The weather looks peaceful tonight\.$/);
		expect(h.deliveries[0].text).not.toMatch(/All clear/);
	});

	test("a report that fails to send is retried as the incident's alert", async () => {
		const h = reportHarness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		h.pushResult.value = (id) => (id === 1 ? { sent: 0, failed: 1 } : { sent: 1, failed: 0 });
		await evening(h);
		const mine = () => h.db.notes.find((n) => n.profile_id === 1 && n.kind === "alert");
		expect(mine()).toMatchObject({ status: "failed", attempts: 1 });
		h.pushResult.value = { sent: 1, failed: 0 };
		h.advance("2026-10-23T21:05:00-04:00");
		await h.engine.plan();
		expect(mine()).toMatchObject({ status: "sent", attempts: 2 });
		expect(h.deliveries.at(-1).text).toMatch(/^ALERT: Your garage door is still open/);
	});

	test("6 AM after a quiet night: sent by the planner alone, no camera woken", async () => {
		const h = reportHarness();
		await h.ready;
		await evening(h);
		const shots = h.deps.observeDeps.snapshot.mock.calls.length;
		h.advance("2026-10-24T06:00:30-04:00");
		await h.engine.plan(); // the job — it can't reach a camera, and doesn't need one
		expect(h.deps.observeDeps.snapshot.mock.calls.length).toBe(shots);
		expect(h.deliveries.at(-1).text).toBe("Good morning, I hope you slept well through the night. All quiet — nothing happened overnight.");
		expect(h.db.runs.find((r) => r.occurrence_key === "morning:2026-10-24")).toMatchObject({ state: "safe", trigger_kind: "report" });
	});

	test("6 AM after an eventful night says what happened", async () => {
		const h = reportHarness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		await evening(h);
		h.answers.garage_door = { visible: true, state: "closed", confidence: 0.97 };
		h.advance("2026-10-23T21:16:00-04:00");
		await h.engine.runDue();
		h.db.strangers = { count: 2, firstAt: at("2026-10-24T02:14:00-04:00"), camera: "Doorbell" };
		h.advance("2026-10-24T06:00:30-04:00");
		await h.engine.plan();
		expect(h.deliveries.at(-1).text).toBe(
			"Good morning, I hope you slept well through the night. Overnight: the garage door was open at 9:00 PM, fixed by 9:16 PM and the cameras saw a stranger 2 times (first at 2:14 AM on the Doorbell)."
		);
	});

	test("6 AM with the door still open says so", async () => {
		const h = reportHarness();
		await h.ready;
		h.answers.garage_door = { visible: true, state: "open", confidence: 0.95 };
		await evening(h);
		h.advance("2026-10-24T06:00:30-04:00");
		await h.engine.plan();
		expect(h.deliveries.at(-1).text).toMatch(/Overnight: the garage door is still open \(since 9:00 PM\)\.$/);
	});

	test("changing the times moves what's already booked", async () => {
		const h = reportHarness();
		await h.ready;
		h.advance("2026-10-23T12:00:00-04:00");
		await h.engine.plan();
		const current = h.db.protocols.find((p) => p.protocol_id === "nightly_sweep").config;
		await h.engine.saveConfig(1, "nightly_sweep", { config: { ...current, schedule: { ...current.schedule, time: "21:30" }, reports: { ...current.reports, morningTime: "06:45" } } });
		const when = (key) => new Date(h.db.runs.find((r) => r.occurrence_key === key).scheduled_for).toISOString();
		expect(when("2026-10-23")).toBe(at("2026-10-23T21:30:00-04:00").toISOString());
		expect(when("morning:2026-10-24")).toBe(at("2026-10-24T06:45:00-04:00").toISOString());
		expect(h.db.protocols.find((p) => p.protocol_id === "nightly_sweep").enabled).toBe(true);
	});

	test("morning report off: nothing booked for 6 AM", async () => {
		const h = reportHarness({ sweep: { reports: { evening: true, morning: false } } });
		await h.ready;
		await h.engine.plan();
		expect(h.db.runs.some((r) => r.trigger_kind === "report")).toBe(false);
	});
});

describe("protocol plumbing", () => {
	test("a disabled protocol books nothing", async () => {
		const h = harness({ sweepOn: false, stormOn: false });
		await h.ready;
		await h.engine.plan();
		expect(h.db.runs).toHaveLength(0);
	});

	test("enabled after tonight's time: tomorrow's sweep, not a missed one", async () => {
		const h = harness();
		await h.ready;
		h.advance("2026-10-23T23:30:00-04:00");
		await h.engine.plan();
		expect(h.db.runs.map((r) => r.occurrence_key)).toEqual(["2026-10-24"]);
		expect(incidentsOf(h)).toHaveLength(0);
	});

	test("10 PM is computed in the household's zone across the DST change", () => {
		expect(protocols.zonedInstant("2026-11-01", "22:00", "America/New_York").toISOString()).toBe("2026-11-02T03:00:00.000Z");
		expect(protocols.zonedInstant("2026-10-31", "22:00", "America/New_York").toISOString()).toBe("2026-11-01T02:00:00.000Z");
	});

	test("config cleaning refuses junk and fills defaults", () => {
		expect(() => protocols.normalizeConfig("nightly_sweep", { garageDoors: [{ name: "x", serial: "../../etc" }] })).toThrow(/camera id/);
		const c = protocols.normalizeConfig("nightly_sweep", { schedule: { time: "25:00" }, retries: 99, minConfidence: 0.1 });
		expect(c).toMatchObject({ schedule: { time: "21:00" }, retries: 2, minConfidence: 0.75, reports: { evening: true, morning: true, morningTime: "06:00" } });
		expect(protocols.normalizeConfig("nightly_sweep", { reports: { morningTime: "6:30", evening: false } }).reports).toEqual({ evening: false, morning: true, morningTime: "06:30" });
		expect(protocols.normalizeConfig("storm_umbrella", { weather: { gustMph: 30 } }).weather.gustMph).toBe(30);
	});

	test("run states only move forward", () => {
		expect(() => runTransition("safe", "observing")).toThrow(/illegal/);
		expect(runTransition("scheduled", "observing")).toBe("observing");
	});
});
