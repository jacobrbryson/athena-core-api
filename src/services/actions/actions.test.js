/**
 * The action layer: the four gates, and the registry validation that decides
 * what a model is even allowed to ask for.
 *
 * Weighted deliberately toward refusal. An action layer that executes the
 * right thing is worth much less than one that cannot be talked into
 * executing the wrong thing, so most of what follows is a proposal being
 * turned down.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({
	CATEGORIES: new Set(["interest", "routine", "other"]),
	upsertMemoryForProfile: jest.fn(),
}));

const pool = require("../../helpers/db");
const access = require("../../security/access");
const consent = require("../consent");
const credentials = require("../credentials");
const family = require("../family");
const googleCalendar = require("../connectors/googleCalendar");
const memory = require("../memory");
const lookRequests = require("../lookRequests");
const actions = require("./index");
const registry = require("./registry");

const PROFILE = 42;
const UUID = "11111111-2222-4333-8444-555555555555";

/** A start/end pair safely in the future, with a real UTC offset. */
function soon(hoursFromNow = 24, lengthHours = 1) {
	const start = new Date(Date.now() + hoursFromNow * 3600000);
	const end = new Date(start.getTime() + lengthHours * 3600000);
	return { start: start.toISOString(), end: end.toISOString() };
}

/** The same pair with no UTC offset at all, which is what models emit. */
function local(hoursFromNow = 48, lengthHours = 1) {
	const { start, end } = soon(hoursFromNow, lengthHours);
	return { start: start.slice(0, 19), end: end.slice(0, 19) };
}

/** The row shape services/actions selects back after a write. */
function actionRow(over = {}) {
	return {
		uuid: UUID,
		action_id: "create_calendar_event",
		params: JSON.stringify({ title: "Dentist", ...soon() }),
		rationale: "You asked me to book it",
		summary: 'Add "Dentist" to your calendar',
		status: "pending",
		approval: null,
		result_ref: null,
		error: null,
		created_at: new Date(),
		expires_at: new Date(Date.now() + 600000),
		decided_at: null,
		executed_at: null,
		...over,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	pool.query.mockResolvedValue([[], {}]);
	access.assertModelAccess.mockResolvedValue(undefined);
	consent.hasConsentForProfile.mockResolvedValue(true);
	credentials.list.mockResolvedValue([{ provider: "google_calendar", status: "active" }]);
	family.getFamilyForProfile.mockResolvedValue({ id: 7 });
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// Registry validation — the untrusted-input boundary
// ---------------------------------------------------------------------------

describe("create_calendar_event params", () => {
	const action = registry.get("create_calendar_event");
	const normalize = (over) => action.normalize({ title: "Dentist", ...soon(), ...over });

	test("a well-formed event normalizes", () => {
		const p = normalize();
		expect(p.title).toBe("Dentist");
		expect(p.start).toBeTruthy();
		expect(p.end).toBeTruthy();
	});

	test("an offsetless start with no time_zone is refused, not guessed", () => {
		// The single most likely model output, and the most dangerous: "2pm" in
		// an unknown zone books the wrong hour silently.
		const { start, end } = local();
		expect(() => normalize({ start, end })).toThrow(/UTC offset|time_zone/);
	});

	test("an offsetless start IS accepted when a zone is supplied", () => {
		const { start, end } = local();
		const p = normalize({ start, end, time_zone: "America/New_York" });
		expect(p.time_zone).toBe("America/New_York");
		expect(p.start).toBe(start);
	});

	test("attendees are refused rather than dropped", () => {
		// Dropping them silently would create an event the person approved.
		// Refusing is right because the version they approved had guests in it,
		// and inviting people mails them.
		expect(() => normalize({ attendees: ["someone@example.com"] })).toThrow(/cannot invite/i);
		expect(() => normalize({ guests: ["someone@example.com"] })).toThrow(/cannot invite/i);
	});

	test("a model-chosen calendar is refused", () => {
		expect(() => normalize({ calendar_id: "family@group.calendar.google.com" })).toThrow(
			/primary calendar/i
		);
	});

	test("an event ending before it starts is refused", () => {
		const { start, end } = soon();
		expect(() => normalize({ start: end, end: start })).toThrow(/cannot end before/i);
	});

	test("a date a year out is refused", () => {
		const far = soon(24 * 400);
		expect(() => normalize(far)).toThrow(/too far in the future/i);
	});

	test("an event in the past is refused", () => {
		const past = soon(-72);
		expect(() => normalize(past)).toThrow(/in the past/i);
	});

	test("a title is required", () => {
		expect(() => action.normalize({ ...soon() })).toThrow(/title/i);
		expect(() => action.normalize({ title: "   ", ...soon() })).toThrow(/title/i);
	});

	test("an injected time_zone is rejected on shape", () => {
		const { start, end } = local();
		// The zone fails the shape check, which leaves the offsetless start
		// with nothing to be read in — so the whole proposal is refused
		// rather than booked in a zone nobody chose.
		expect(() =>
			normalize({ start, end, time_zone: "'; DROP TABLE athena_action; --" })
		).toThrow(/UTC offset|time_zone/);
	});

	test("an all-day event gets Google's exclusive end date", () => {
		const p = action.normalize({
			title: "Holiday",
			all_day: true,
			start: "2030-06-01",
			end: "2030-06-01",
		});
		// One day long: Google reads `end` as exclusive, so it must be the 2nd.
		expect(p).toMatchObject({ all_day: true, start: "2030-06-01", end: "2030-06-02" });
	});

	test("fields the registry does not vouch for cannot reach execute", () => {
		const p = normalize({ sendUpdates: "all", organizer: "someone@example.com", colorId: 3 });
		expect(Object.keys(p).sort()).toEqual(["end", "start", "title"]);
	});

	test("the summary names what the person is approving", () => {
		const p = normalize({ title: "Dentist", location: "Main St" });
		expect(action.summarize(p)).toMatch(/Dentist/);
		expect(action.summarize(p)).toMatch(/Main St/);
	});
});

describe("remember_fact params", () => {
	const action = registry.get("remember_fact");

	test("a known category normalizes", () => {
		expect(action.normalize({ category: "Routine", key: "gym", value: "Tuesdays" })).toEqual({
			category: "routine",
			key: "gym",
			value: "Tuesdays",
		});
	});

	test("an unknown category is refused, not coerced to 'other'", () => {
		// memory.js would silently coerce it. Coercion here would file a fact
		// under a category the person never saw on the card.
		expect(() => action.normalize({ category: "nonsense", key: "k", value: "v" })).toThrow(
			/Category must be one of/
		);
	});

	test("key and value are required", () => {
		expect(() => action.normalize({ category: "other", value: "v" })).toThrow(/key/i);
		expect(() => action.normalize({ category: "other", key: "k" })).toThrow(/value/i);
	});
});

// ---------------------------------------------------------------------------
// Gate 1 + 2: propose
// ---------------------------------------------------------------------------

describe("look_through_camera params", () => {
	const look = registry.get("look_through_camera");

	test("a look with no stated reason is refused", () => {
		// A camera that opens without a reason the person can read is not
		// something to ship, so the reason is the one required parameter.
		expect(() => look.normalize({})).toThrow(/reason/i);
		expect(() => look.normalize({ reason: "   " })).toThrow(/reason/i);
		expect(() => look.normalize({ reason: 42 })).toThrow(/reason/i);
		expect(() => look.normalize({ prefer: "front" })).toThrow(/reason/i);
	});

	test("an unrecognised camera hint is refused, not ignored", () => {
		// Dropping it silently would open a camera the person did not expect.
		expect(() => look.normalize({ reason: "ok", prefer: "rear" })).toThrow(/front/i);
		expect(() => look.normalize({ reason: "ok", prefer: "both" })).toThrow(/front/i);
	});

	test("accepts a reason alone, and both hints", () => {
		expect(look.normalize({ reason: "You asked what I think of it." })).toEqual({
			reason: "You asked what I think of it.",
		});
		expect(look.normalize({ reason: "ok", prefer: "FRONT" })).toEqual({
			reason: "ok",
			prefer: "front",
		});
		expect(look.normalize({ reason: "ok", prefer: "room" })).toEqual({
			reason: "ok",
			prefer: "room",
		});
	});

	test("the reason the person reads is the reason she gave", () => {
		expect(look.summarize({ reason: "You are showing me something." })).toBe(
			"Take a look through your camera: You are showing me something."
		);
	});

	test("it is not reversible, and the card must not imply otherwise", () => {
		// A look cannot be taken back, and a notable one becomes a memory.
		expect(look.reversible).toBe(false);
		expect(look.standing).toBe(true);
		expect(look.consentType).toBe("action_authority");
	});

	test("executing records a request rather than reaching a camera", async () => {
		lookRequests.create.mockResolvedValue({ uuid: "look-1" });
		const result = await look.execute(7, { reason: "ok", prefer: "front" }, { actionUuid: "act-1" });
		expect(lookRequests.create).toHaveBeenCalledWith(7, {
			reason: "ok",
			prefer: "front",
			actionUuid: "act-1",
		});
		expect(result.ref).toBe("look-1");
	});

	test("fails rather than queueing when she already has looks outstanding", async () => {
		// Several cameras opening at once the moment a device appears is what
		// the cap exists to prevent, so this must not silently succeed.
		lookRequests.create.mockResolvedValue(null);
		await expect(look.execute(7, { reason: "ok" }, {})).rejects.toThrow(/already has a look/i);
	});
});

describe("propose", () => {
	test("an unknown action id is dropped, never stored", async () => {
		const result = await actions.propose(PROFILE, 1, { id: "delete_everything", params: {} });
		expect(result).toBeNull();
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("an action whose provider is not linked is dropped", async () => {
		credentials.list.mockResolvedValue([]);
		const result = await actions.propose(PROFILE, 1, {
			id: "create_calendar_event",
			params: { title: "Dentist", ...soon() },
		});
		expect(result).toBeNull();
	});

	test("a stale link (not active) does not count as linked", async () => {
		credentials.list.mockResolvedValue([
			{ provider: "google_calendar", status: "needs_reauth" },
		]);
		const result = await actions.propose(PROFILE, 1, {
			id: "create_calendar_event",
			params: { title: "Dentist", ...soon() },
		});
		expect(result).toBeNull();
	});

	test("without the family consent, the calendar action is not proposable", async () => {
		consent.hasConsentForProfile.mockResolvedValue(false);
		const result = await actions.propose(PROFILE, 1, {
			id: "create_calendar_event",
			params: { title: "Dentist", ...soon() },
		});
		expect(result).toBeNull();
	});

	test("invalid params are dropped without a row", async () => {
		const result = await actions.propose(PROFILE, 1, {
			id: "create_calendar_event",
			params: { title: "Dentist" }, // no start
		});
		expect(result).toBeNull();
		expect(pool.query).not.toHaveBeenCalledWith(
			expect.stringContaining("INSERT INTO athena_action"),
			expect.anything()
		);
	});

	test("a valid proposal is stored as pending, with the normalized params", async () => {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("INSERT INTO athena_action\n")) return [{ affectedRows: 1 }];
			if (sql.includes("SELECT") && sql.includes("FROM athena_action WHERE uuid"))
				return [[actionRow()]];
			return [[], {}];
		});
		const result = await actions.propose(PROFILE, 9, {
			id: "create_calendar_event",
			params: { title: "Dentist", ...soon() },
			rationale: "You asked",
		});
		expect(result).toMatchObject({ status: "pending", action_id: "create_calendar_event" });

		const insert = pool.query.mock.calls.find((c) => c[0].includes("INSERT INTO athena_action\n"));
		const stored = JSON.parse(insert[1][4]);
		// What is stored is normalize()'s output, not the model's object.
		expect(Object.keys(stored).sort()).toEqual(["end", "start", "title"]);
		// 'pending' is a literal in the SQL, never a bindable parameter, so no
		// caller can insert a row that starts out already approved.
		expect(insert[0]).toContain("'pending'");
		expect(insert[1][7]).toBe(actions.PROPOSAL_TTL_MS / 1000);
	});

	test("nothing is proposed for a profileless session", async () => {
		expect(await actions.propose(null, 1, { id: "remember_fact", params: {} })).toBeNull();
		expect(pool.query).not.toHaveBeenCalled();
	});

	test("an unreadable credential list means no actions, not all actions", async () => {
		credentials.list.mockRejectedValue(new Error("db down"));
		expect(await actions.availableFor(PROFILE)).toEqual([]);
	});

	test("an unreadable consent means no actions", async () => {
		consent.hasConsentForProfile.mockRejectedValue(new Error("db down"));
		expect(await actions.availableFor(PROFILE)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Gate 3 + 4: confirm
// ---------------------------------------------------------------------------

describe("confirm", () => {
	/** Claim wins, row comes back, provider succeeds. */
	function happyPath({ claimed = 1, row = actionRow() } = {}) {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("SET status = 'executing'")) return [{ affectedRows: claimed }];
			if (sql.includes("SELECT action_id, params")) return [[row]];
			if (sql.includes("FROM athena_action WHERE uuid"))
				return [[{ ...row, status: "done", result_ref: "evt_1" }]];
			return [[], {}];
		});
	}

	test("live access is re-checked before anything else", async () => {
		access.assertModelAccess.mockRejectedValue(
			Object.assign(new Error("Guardian access or owner approval required"), { status: 403 })
		);
		happyPath();
		await expect(actions.confirm(PROFILE, UUID)).rejects.toThrow(/access/i);
		// Nothing was claimed, so nothing can have executed.
		expect(googleCalendar.createEvent).not.toHaveBeenCalled();
		const claimed = pool.query.mock.calls.some((c) => c[0].includes("SET status = 'executing'"));
		expect(claimed).toBe(false);
	});

	test("a granted access check leads to exactly one provider call", async () => {
		happyPath();
		googleCalendar.createEvent.mockResolvedValue({ ref: "evt_1", html_link: "https://cal" });
		const result = await actions.confirm(PROFILE, UUID);
		expect(googleCalendar.createEvent).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ status: "done", result_ref: "evt_1" });
	});

	test("the claim is guarded on status AND expiry AND owner", async () => {
		happyPath();
		googleCalendar.createEvent.mockResolvedValue({ ref: "evt_1" });
		await actions.confirm(PROFILE, UUID);
		const claim = pool.query.mock.calls.find((c) => c[0].includes("SET status = 'executing'"));
		expect(claim[0]).toContain("status = 'pending'");
		expect(claim[0]).toContain("expires_at > NOW()");
		expect(claim[0]).toContain("profile_id = ?");
		expect(claim[1]).toContain(PROFILE);
	});

	test("a second press loses the race and executes nothing", async () => {
		// affectedRows 0 is what the database says when another request already
		// moved the row out of pending.
		happyPath({ claimed: 0 });
		await expect(actions.confirm(PROFILE, UUID)).rejects.toMatchObject({ code: "not_pending" });
		expect(googleCalendar.createEvent).not.toHaveBeenCalled();
	});

	test("someone else's proposal is indistinguishable from a missing one", async () => {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("SET status = 'executing'")) return [{ affectedRows: 0 }];
			return [[], {}]; // get() finds nothing: not theirs
		});
		await expect(actions.confirm(PROFILE, UUID)).rejects.toThrow("No such request");
	});

	test("an action id that has left the registry fails closed", async () => {
		happyPath({ row: actionRow({ action_id: "retired_action" }) });
		await expect(actions.confirm(PROFILE, UUID)).rejects.toMatchObject({
			code: "unknown_action",
		});
		const settle = pool.query.mock.calls.find((c) => c[0].includes("SET status = ?, result_ref"));
		expect(settle[1][0]).toBe("failed");
	});

	test("a provider failure marks the row failed and re-throws", async () => {
		happyPath();
		googleCalendar.createEvent.mockRejectedValue(
			Object.assign(new Error("re-link Google Calendar"), { code: "needs_reauth" })
		);
		await expect(actions.confirm(PROFILE, UUID)).rejects.toMatchObject({ code: "needs_reauth" });
		const settle = pool.query.mock.calls.find((c) => c[0].includes("SET status = ?, result_ref"));
		expect(settle[1][0]).toBe("failed");
		expect(settle[1][2]).toMatch(/re-link/);
	});

	test("every execution writes an audit row", async () => {
		happyPath();
		googleCalendar.createEvent.mockResolvedValue({ ref: "evt_1" });
		await actions.confirm(PROFILE, UUID);
		const audits = pool.query.mock.calls.filter((c) =>
			c[0].includes("INSERT INTO athena_access_audit")
		);
		expect(audits.map((a) => a[1][1])).toContain("action_executed");
	});

	test("an audit write that fails does not undo a completed execution", async () => {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("INSERT INTO athena_access_audit")) throw new Error("audit table gone");
			if (sql.includes("SET status = 'executing'")) return [{ affectedRows: 1 }];
			if (sql.includes("SELECT action_id, params")) return [[actionRow()]];
			if (sql.includes("FROM athena_action WHERE uuid"))
				return [[actionRow({ status: "done", result_ref: "evt_1" })]];
			return [[], {}];
		});
		googleCalendar.createEvent.mockResolvedValue({ ref: "evt_1" });
		const result = await actions.confirm(PROFILE, UUID);
		expect(result.status).toBe("done");
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("AUDIT WRITE FAILED"),
			expect.anything(),
			expect.anything(),
			expect.anything()
		);
	});

	test("remember_fact records 'ai' provenance, a value memory.js accepts", async () => {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("SET status = 'executing'")) return [{ affectedRows: 1 }];
			if (sql.includes("SELECT action_id, params"))
				return [
					[
						{
							action_id: "remember_fact",
							params: JSON.stringify({ category: "routine", key: "gym", value: "Tuesdays" }),
						},
					],
				];
			if (sql.includes("FROM athena_action WHERE uuid"))
				return [[actionRow({ action_id: "remember_fact", status: "done" })]];
			return [[], {}];
		});
		memory.upsertMemoryForProfile.mockResolvedValue({ uuid: "mem-1" });
		await actions.confirm(PROFILE, UUID, { familyId: 7 });
		expect(memory.upsertMemoryForProfile).toHaveBeenCalledWith(
			PROFILE,
			7,
			expect.objectContaining({ source: "ai", key: "gym" })
		);
	});
});

// ---------------------------------------------------------------------------
// Standing approvals
// ---------------------------------------------------------------------------

describe("standing approvals", () => {
	test("a standing authority executes inline, recorded as 'standing'", async () => {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("FROM athena_action_authority")) return [[{ id: 3, expires_at: null }]];
			if (sql.includes("INSERT INTO athena_action\n")) return [{ affectedRows: 1 }];
			if (sql.includes("SET status = 'executing'")) return [{ affectedRows: 1 }];
			if (sql.includes("SELECT action_id, params")) return [[actionRow()]];
			if (sql.includes("FROM athena_action WHERE uuid"))
				return [[actionRow({ status: "done", approval: "standing" })]];
			return [[], {}];
		});
		googleCalendar.createEvent.mockResolvedValue({ ref: "evt_1" });
		const result = await actions.propose(PROFILE, 1, {
			id: "create_calendar_event",
			params: { title: "Dentist", ...soon() },
		});
		expect(result).toMatchObject({ status: "done", approval: "standing" });

		const claim = pool.query.mock.calls.find((c) => c[0].includes("SET status = 'executing'"));
		expect(claim[1][0]).toBe("standing");
		expect(claim[1][1]).toBe(3); // the authority is named on the row
	});

	test("a standing authority does NOT skip the live access check", async () => {
		access.assertModelAccess.mockRejectedValue(new Error("denied"));
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("FROM athena_action_authority")) return [[{ id: 3, expires_at: null }]];
			if (sql.includes("INSERT INTO athena_action\n")) return [{ affectedRows: 1 }];
			return [[], {}];
		});
		// propose() lets the execution error out; the row stays pending, so the
		// person can still approve it by hand later.
		await expect(
			actions.propose(PROFILE, 1, {
				id: "create_calendar_event",
				params: { title: "Dentist", ...soon() },
			})
		).rejects.toThrow(/denied/);
		expect(googleCalendar.createEvent).not.toHaveBeenCalled();
	});

	test("a revoked authority is not live", async () => {
		pool.query.mockResolvedValue([[], {}]);
		expect(await actions.liveAuthority(PROFILE, "create_calendar_event")).toBeNull();
		const q = pool.query.mock.calls[0][0];
		expect(q).toContain("revoked_at IS NULL");
		expect(q).toContain("expires_at IS NULL OR expires_at > NOW()");
	});

	test("granting requires the action's consent", async () => {
		consent.hasConsentForProfile.mockResolvedValue(false);
		await expect(actions.grantAuthority(PROFILE, "create_calendar_event")).rejects.toMatchObject(
			{ code: "consent_required" }
		);
	});

	test("granting an unknown action is refused", async () => {
		await expect(actions.grantAuthority(PROFILE, "nope")).rejects.toMatchObject({
			code: "unknown_action",
		});
	});

	test("the granter is the caller's own profile, never a body field", async () => {
		pool.query.mockResolvedValue([[], {}]);
		await actions.grantAuthority(PROFILE, "remember_fact");
		const insert = pool.query.mock.calls.find((c) =>
			c[0].includes("INSERT INTO athena_action_authority")
		);
		// profile_id, action_id, granted_by, expires_at
		expect(insert[1][0]).toBe(PROFILE);
		expect(insert[1][2]).toBe(PROFILE);
	});
});

// ---------------------------------------------------------------------------
// Decline, expiry, prompt block
// ---------------------------------------------------------------------------

describe("decline and expiry", () => {
	test("a decline is recorded, not deleted", async () => {
		pool.query.mockImplementation(async (sql) => {
			if (sql.includes("SET status = 'declined'")) return [{ affectedRows: 1 }];
			if (sql.includes("FROM athena_action WHERE uuid"))
				return [[actionRow({ status: "declined" })]];
			return [[], {}];
		});
		const result = await actions.decline(PROFILE, UUID);
		expect(result.status).toBe("declined");
		// The audit names the action, not the proposal uuid, so a scan of the
		// access audit reads the same way for a refusal as for an execution.
		const audits = pool.query.mock.calls.filter((c) =>
			c[0].includes("INSERT INTO athena_access_audit")
		);
		expect(audits[0][1]).toEqual([
			String(PROFILE),
			"action_declined",
			"create_calendar_event",
		]);
		expect(
			pool.query.mock.calls.some((c) => c[0].includes("DELETE FROM athena_action"))
		).toBe(false);
	});

	test("declining something already decided is refused", async () => {
		pool.query.mockResolvedValue([{ affectedRows: 0 }]);
		await expect(actions.decline(PROFILE, UUID)).rejects.toMatchObject({ code: "not_pending" });
	});

	test("expireStale only touches pending rows that are past due", async () => {
		pool.query.mockResolvedValue([{ affectedRows: 4 }]);
		expect(await actions.expireStale()).toBe(4);
		const sql = pool.query.mock.calls[0][0];
		expect(sql).toContain("status = 'pending'");
		expect(sql).toContain("expires_at <= NOW()");
	});

	test("listPending hides expired rows", async () => {
		pool.query.mockResolvedValue([[], {}]);
		await actions.listPending(PROFILE);
		expect(pool.query.mock.calls[0][0]).toContain("expires_at > NOW()");
	});
});

describe("promptBlock", () => {
	test("no available actions means no block at all", () => {
		expect(actions.promptBlock([])).toBeNull();
		expect(actions.promptBlock(null)).toBeNull();
	});

	test("the block tells her she cannot execute, and names each action", () => {
		const block = actions.promptBlock(registry.ACTIONS);
		expect(block).toMatch(/cannot perform any of these yourself/i);
		expect(block).toMatch(/never claim it is done/i);
		for (const action of registry.ACTIONS) expect(block).toContain(action.id);
	});

	test("it caps her at one proposal per reply", () => {
		expect(actions.promptBlock(registry.ACTIONS)).toMatch(/at most ONE action per reply/i);
	});
});
