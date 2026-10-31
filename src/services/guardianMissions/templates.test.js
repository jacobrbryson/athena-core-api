const pool = require("../../helpers/db");
const missions = require("./index");
const templates = require("./templates");
const registry = require("../actions/registry");
const { preflight } = require("./runner");
const { normalize, reviewDraft } = require("./planning");

jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../guardianEngine/dispatch", () => ({ wakeAt: jest.fn() }));
jest.mock("../../helpers/crypto", () => ({ encrypt: jest.fn(), decrypt: jest.fn() }));
jest.mock("./index", () => ({ capabilityByKey: jest.fn(), actorByKey: jest.fn(), log: jest.fn(), parentActor: jest.fn(), missionByUuid: jest.fn() }));

const template = { capability_keys: '["push_notification","clue_planning"]', actor_keys: '["ross","thomas"]', zone_uuids: '["z1"]', max_minutes: 90 };
const plan = { zone: "z1", steps: [{ actor: "ross", dueMinutes: 30 }, { actor: "thomas", dueMinutes: 30 }] };
const fits = (over = {}) => templates.outsideLimits({ plan, capabilityKeys: ["clue_planning"], ...over }, template);

beforeEach(() => {
	jest.clearAllMocks();
	delete process.env.GM_TEMPLATES_ENABLED;
});

describe("template limits", () => {
	test("a draft inside every limit fits", () => {
		expect(fits()).toEqual([]);
	});

	test("anything outside one limit doesn't", () => {
		expect(fits({ capabilityKeys: ["porch_light"] })[0]).toMatch(/porch_light/);
		expect(fits({ plan: { steps: [{ actor: "skylar", dueMinutes: 5 }] } })[0]).toMatch(/skylar/);
		expect(fits({ plan: { zone: "z2", steps: [] } })[0]).toMatch(/zone/);
		expect(fits({ plan: { steps: [{ actor: "ross", dueMinutes: 120 }] } })[0]).toMatch(/120 minutes/);
		expect(fits({ wishes: 1 })[0]).toMatch(/built/);
		expect(fits({ reach: 2 })[0]).toMatch(/household/);
	});

	test("nothing fits while templates are off", async () => {
		expect(await templates.fitFor({ status: "proposed" })).toBeNull();
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("nothing fits once a mission has left the proposed state", async () => {
		process.env.GM_TEMPLATES_ENABLED = "on";
		expect(await templates.fitFor({ status: "running" })).toBeNull();
	});
});

describe("creating a template", () => {
	const owner = { id: 2, family_id: 1 };
	const body = { name: "Yard hunts", capabilities: ["clue_planning"], people: ["thomas"], maxMinutes: 60 };

	test("a tool needing approval each time can't go in one", async () => {
		missions.capabilityByKey.mockResolvedValue({ kind: "system", permission: "parent_approval", name: "Speak through camera" });
		await expect(templates.normalizeTemplate(body, owner)).rejects.toThrow(/approval each time/);
	});

	test("only this family's people, and only known fields", async () => {
		missions.capabilityByKey.mockResolvedValue({ kind: "system", permission: "free" });
		missions.actorByKey.mockResolvedValue(null);
		await expect(templates.normalizeTemplate(body, owner)).rejects.toThrow(/isn't in this family/);
		missions.actorByKey.mockResolvedValue({ id: 3 });
		const out = await templates.normalizeTemplate({ ...body, status: "approved", family_id: 9 }, owner);
		expect(out).toEqual({ family_id: 1, by: 2, name: "Yard hunts", capabilityKeys: ["clue_planning"], actorKeys: ["thomas"], zoneUuids: [], maxMinutes: 60 });
	});

	test("only the flagged owner can, whatever their family role", async () => {
		const action = registry.DIRECT_ACTIONS.find((a) => a.id === "approve_guardian_template");
		missions.parentActor.mockResolvedValue({ id: 6, family_id: 2, can_create_templates: 0 });
		expect(await action.availableTo(6)).toBe(false);
		await expect(action.normalize(body, { profileId: 6 })).rejects.toThrow(/Only the owner/);
	});
});

describe("the actions", () => {
	test("are never standing and never offered to a model", () => {
		for (const id of ["approve_guardian_template", "start_templated_mission"]) {
			const action = registry.DIRECT_ACTIONS.find((a) => a.id === id);
			expect(action).toMatchObject({ direct: true, standing: false });
			expect(registry.ACTIONS.map((a) => a.id)).not.toContain(id);
		}
	});

	test("starting refuses a draft outside any template", async () => {
		const action = registry.DIRECT_ACTIONS.find((a) => a.id === "start_templated_mission");
		missions.parentActor.mockResolvedValue({ id: 2, family_id: 1 });
		missions.missionByUuid.mockResolvedValue({ status: "proposed" });
		await expect(action.normalize({ mission: "m" }, { profileId: 1 })).rejects.toThrow(/isn't inside/);
	});
});

describe("zones", () => {
	const zone = { lat: 35.6, lng: -80.8, radius_m: 100 };

	test("inside and outside, with limited GPS forgiveness", () => {
		expect(templates.insideZone(zone, { lat: 35.6, lng: -80.8 })).toBe(true);
		expect(templates.insideZone(zone, { lat: 35.61, lng: -80.8 })).toBe(false);
		expect(templates.insideZone(zone, { lat: 35.61, lng: -80.8, accuracy: 5000 })).toBe(false);
	});

	test("no location reading is not inside", () => {
		expect(templates.insideZone(zone, { lat: null, lng: null })).toBe(false);
	});

	test("a zone with no map limit trusts the off-limits words", () => {
		expect(templates.insideZone({ lat: null }, {})).toBe(true);
	});

	test("daylight follows the family's clock", () => {
		expect(templates.isDaylight(new Date("2026-11-01T16:00:00Z"), "America/New_York")).toBe(true);
		expect(templates.isDaylight(new Date("2026-11-02T03:00:00Z"), "America/New_York")).toBe(false);
	});

	test("creating one needs what's off limits", async () => {
		await expect(templates.createZone(1, { name: "Yard" }, { id: 2 })).rejects.toThrow(/off limits/);
	});

	const flight = (over = {}) => preflight({
		mission: { approval_state: "approved", status: "running", family_id: 1 },
		steps: [{ assigned_actor_id: 3, cap_key: "scout_geography" }],
		actors: [{ id: 3, kind: "kid", family_id: 1, display_name: "Thomas" }],
		agreements: { 3: { allowed: true } },
		contacts: { 3: [{ reachable: true }] },
		capabilities: [{ cap_key: "push_notification", name: "Push", enabled: 1 }],
		control: {},
		...over,
	});

	test("a kid scouting needs a zone, and daylight if the zone says so", () => {
		expect(flight().join(" ")).toMatch(/approved zone/);
		expect(flight({ zone: { daylight_only: 1, name: "Yard" }, daylight: false }).join(" ")).toMatch(/daylight only/);
		expect(flight({ zone: { daylight_only: 1, name: "Yard" }, daylight: true })).toEqual([]);
	});

	test("a draft sending a kid to scout has to name an approved zone", () => {
		const actors = [{ actor_key: "ross", kind: "parent" }, { actor_key: "thomas", kind: "kid" }];
		const raw = {
			title: "Scout the yard",
			goal: "See the yard.",
			reason: "Scouting is unproven.",
			capabilities: ["push_notification", "scout_geography"],
			steps: [{ key: "scout", phase: "live", actor: "thomas", capability: "scout_geography", instruction: "Photograph the yard in four directions.", proof: "photo_set", dueMinutes: 20 }],
			passCriteria: [{ key: "d", kind: "all_steps_done", text: "It got done", capability: "scout_geography" }],
			safety: { where: "Yard", supervision: "A parent", offLimits: "The road" },
		};
		const keys = ["push_notification", "scout_geography"];
		expect(reviewDraft(normalize(raw, keys), { skillKeys: [], actors }).join(" ")).toMatch(/approved zone/);
		expect(reviewDraft(normalize({ ...raw, zone: "z1" }, keys), { skillKeys: [], actors, zones: ["z1"] })).toEqual([]);
	});
});
