jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./llm", () => ({ generateJson: jest.fn() }));
jest.mock("./securityMedia", () => ({ open: jest.fn(), setImportant: jest.fn(), save: jest.fn(), remove: jest.fn() }));
const pool = require("../helpers/db");
const securityMedia = require("./securityMedia");
const sightings = require("./sightings");

const saved = [];
beforeEach(() => {
	saved.length = 0;
	pool.query.mockReset();
	sightings._setStorage({ bucket: (b) => ({ file: (n) => ({ save: jest.fn(async () => saved.push(`${b}/${n}`)), delete: jest.fn(async () => {}), download: jest.fn(async () => [Buffer.from(`frame:${b}/${n}`)]) }) }) });
});

const gallery = [
	{ id: "s-wynter", name: "Wynter", kind: "animal", description: "black lab", photos: [] },
	{ id: "s-ross", name: "Ross", kind: "person", description: null, photos: [] },
];
const zones = [{ name: "outside the back fence" }, { name: "inside the fence" }];

describe("cleanSubjects", () => {
	test("a package is always just 'package', never a gallery name, and keeps what it looks like", () => {
		const out = sightings.cleanSubjects([
			{ name: "Wynter", kind: "package", label: "Amazon box", where: "small brown box on the doormat", zone: "inside the fence", confidence: 0.8 },
		], gallery, zones);
		expect(out).toEqual([{ subject: null, label: "package", kind: "package", zone: "inside the fence", where: "small brown box on the doormat", confidence: 0.8 }]);
	});
	test("an alert rule can be set for packages", async () => {
		pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
		await sightings.createRule(1, { label: "package" });
		expect(pool.query.mock.calls[0][1][0]).toEqual(expect.objectContaining({ label: "package", subject_id: null }));
		await sightings.createRule(1, { label: sightings.STRANGE_CAR });
		await expect(sightings.createRule(1, { label: "anything" })).rejects.toThrow(/packages/);
	});
	test("a known name is believed only for the same kind", () => {
		const out = sightings.cleanSubjects([{ name: "Wynter", kind: "animal", label: "Wynter", where: "by the fence", zone: "Outside the back fence", confidence: 0.92 }], gallery, zones);
		expect(out[0]).toEqual(expect.objectContaining({ label: "Wynter", zone: "outside the back fence", confidence: 0.92 }));
		expect(out[0].subject.id).toBe("s-wynter");
		const wrongKind = sightings.cleanSubjects([{ name: "Wynter", kind: "person", label: "Wynter", where: "", confidence: 0.9 }], gallery, zones);
		expect(wrongKind[0].subject).toBeNull();
		expect(wrongKind[0].label).toBe("stranger");
	});
	test("an unmatched person is always 'stranger', whatever the model called them", () => {
		const out = sightings.cleanSubjects([{ name: "", kind: "person", label: "mail carrier named Bob", where: "porch", confidence: 0.7 }], gallery, zones);
		expect(out[0].label).toBe("stranger");
		expect(out[0].subject).toBeNull();
	});
	test("a name not in the gallery is not believed and an unknown zone is dropped", () => {
		const out = sightings.cleanSubjects([{ name: "Dexter", kind: "animal", label: "Dexter", where: "yard", zone: "the moon", confidence: 2 }], gallery, zones);
		expect(out[0]).toEqual(expect.objectContaining({ subject: null, label: "Dexter", zone: null, confidence: 1 }));
	});
	test("an unknown subject can't borrow a gallery name", () => {
		const out = sightings.cleanSubjects([{ name: "", kind: "vehicle", label: "Wynter", where: "", confidence: 0.5 }], gallery, zones);
		expect(out[0].label).toBe("unknown vehicle");
	});
});

describe("record", () => {
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
	const event = { id: "motion:T8171B:1", kind: "motion", deviceSn: "T8171B", deviceName: "Backyard", at: "2026-10-18T19:32:00Z" };
	const galleryRows = () => {
		pool.query
			.mockResolvedValueOnce([[{ id: 7, uuid: "s-wynter", name: "Wynter", kind: "animal", description: "black lab" }]]) // subjects
			.mockResolvedValueOnce([[]]) // photos
			.mockResolvedValueOnce([[]]) // last seen
			.mockResolvedValueOnce([[{ device_serial: "T8171B", name: "outside the back fence", description: null }]]); // zones
	};
	test("each subject becomes a row sharing one frame in the bucket", async () => {
		galleryRows();
		pool.query.mockResolvedValueOnce([[{ id: 7, uuid: "s-wynter" }]]).mockResolvedValue([{}]);
		const identifyWith = jest.fn(async ({ zones: z }) => {
			expect(z.map((x) => x.name)).toEqual(["outside the back fence"]);
			return [
				{ subject: { id: "s-wynter" }, label: "Wynter", kind: "animal", zone: "outside the back fence", where: "by the back fence", confidence: 0.9 },
				{ subject: null, label: "stranger", kind: "person", zone: null, where: "gate", confidence: 0.8 },
			];
		});
		const rows = await sightings.record({ event, frame: jpeg }, { identifyWith });
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual(expect.objectContaining({ subject_id: 7, label: "Wynter", device_serial: "T8171B", event_kind: "motion" }));
		expect(rows[1].subject_id).toBeNull();
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatch(/^athena-security-media\/sightings\/2026-10-18\/T8171B\/.+\.jpg$/);
		expect(rows[0].frame_uri).toBe(rows[1].frame_uri);
	});
	test("a frame with nothing in it is not stored", async () => {
		galleryRows();
		const rows = await sightings.record({ event, frame: jpeg }, { identifyWith: async () => [] });
		expect(rows).toEqual([]);
		expect(saved).toHaveLength(0);
	});
	test("an event without a frame records nothing and calls no model", async () => {
		const identifyWith = jest.fn();
		expect(await sightings.record({ event, frame: null }, { identifyWith })).toEqual([]);
		expect(identifyWith).not.toHaveBeenCalled();
	});
	test("a non-JPEG frame or bad device is refused", async () => {
		await expect(sightings.record({ event, frame: Buffer.from("<svg/>").toString("base64") })).rejects.toMatchObject({ status: 400 });
		await expect(sightings.record({ event: { ...event, deviceSn: "../x" }, frame: jpeg })).rejects.toMatchObject({ status: 400 });
	});
});

describe("alerts", () => {
	const now = new Date("2026-10-18T20:00:00Z");
	const at = (min) => new Date(now.getTime() - min * 60_000);
	const rule = { uuid: "r1", profile_id: 1, subject_id: 7, label: null, device_serial: null, zone: "outside the back fence", enabled: 1 };
	test("a run of sightings is one occurrence keyed by where it began", async () => {
		pool.query.mockResolvedValueOnce([[rule]]).mockResolvedValueOnce([[
			{ uuid: "c", subject_id: 7, label: "Wynter", zone: "outside the back fence", seen_at: at(2) },
			{ uuid: "b", subject_id: 7, label: "Wynter", zone: "outside the back fence", seen_at: at(10) },
			{ uuid: "z", subject_id: 7, label: "Wynter", zone: "inside the fence", seen_at: at(15) },
			{ uuid: "a", subject_id: 7, label: "Wynter", zone: "outside the back fence", seen_at: at(25) },
			{ uuid: "old", subject_id: 7, label: "Wynter", zone: "outside the back fence", seen_at: at(120) },
		]]);
		const out = await sightings.activeAlerts(1, { now });
		expect(out).toEqual([expect.objectContaining({ rule: "r1", occurrence: "a" })]);
		expect(out[0].latest.uuid).toBe("c");
	});
	test("nothing matching in the last half hour is no alert", async () => {
		pool.query.mockResolvedValueOnce([[rule]]).mockResolvedValueOnce([[{ uuid: "a", subject_id: 7, label: "Wynter", zone: "outside the back fence", seen_at: at(45) }]]);
		expect(await sightings.activeAlerts(1, { now })).toEqual([]);
	});
	test("no rules means no read of the log at all", async () => {
		pool.query.mockResolvedValueOnce([[]]);
		expect(await sightings.activeAlerts(1, { now })).toEqual([]);
		expect(pool.query).toHaveBeenCalledTimes(1);
	});
	describe("stranger and strange-car rules alert on every event", () => {
		const stranger = { uuid: "r2", profile_id: 1, subject_id: null, label: "stranger", device_serial: null, zone: null, created_at: at(40) };
		const row = (id, min) => ({ uuid: id, event_id: `ev-${id}`, subject_id: null, label: "stranger", kind: "person", seen_at: at(min) });
		const load = (rules, rows, said = []) => pool.query.mockResolvedValueOnce([rules]).mockResolvedValueOnce([rows]).mockResolvedValueOnce([said.map((dedupe_key) => ({ dedupe_key }))]);
		test("the oldest event not yet said comes first, within a run", async () => {
			load([stranger], [row("c", 1), row("b", 5), row("a", 10)], [sightings.alertKey("r2", "ev-a")]);
			expect(await sightings.activeAlerts(1, { now })).toEqual([expect.objectContaining({ rule: "r2", occurrence: "ev-b" })]);
		});
		test("two strangers in one event are one alert", async () => {
			load([stranger], [row("a", 2), { ...row("a2", 2), event_id: "ev-a" }], [sightings.alertKey("r2", "ev-a")]);
			expect(await sightings.activeAlerts(1, { now })).toEqual([]);
		});
		test("sightings from before the rule existed stay quiet", async () => {
			load([{ ...stranger, created_at: at(1) }], [row("a", 5)]);
			expect(await sightings.activeAlerts(1, { now })).toEqual([]);
		});
		test("the key is the one the trigger makes for a single alert", async () => {
			const { createHash } = require("node:crypto");
			expect(sightings.alertKey("r2", "ev-a")).toBe(`sighting:${createHash("sha1").update("r2@ev-a").digest("hex")}`);
		});
		test("a strange car is any vehicle the gallery doesn't hold", () => {
			const car = { subject_id: null, label: sightings.STRANGE_CAR, device_serial: null, zone: null };
			expect(sightings.matches(car, { kind: "vehicle", subject_id: null, label: "white SUV" })).toBe(true);
			expect(sightings.matches(car, { kind: "vehicle", subject_id: 4, label: "Red van" })).toBe(false);
			expect(sightings.matches(car, { kind: "person", subject_id: null, label: "stranger" })).toBe(false);
		});
	});
	describe("pausing a rule", () => {
		test("the update is scoped to the person, and resuming passes the time", async () => {
			pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
			await sightings.setRuleEnabled(1, "r1", true);
			const [sql, args] = pool.query.mock.calls.at(-1);
			expect(sql).toMatch(/created_at = IF\(enabled = 0 AND \? = 1, \?, created_at\), enabled = \?/);
			expect(args).toEqual([1, expect.any(Date), 1, "r1", 1]);
		});
		test("someone else's rule is refused", async () => {
			pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
			await expect(sightings.setRuleEnabled(2, "r1", false)).rejects.toMatchObject({ status: 404 });
		});
		test("a named rule ignores what was seen before it resumed", async () => {
			pool.query.mockResolvedValueOnce([[{ ...rule, created_at: at(1) }]]).mockResolvedValueOnce([[{ uuid: "a", subject_id: 7, label: "Wynter", zone: "outside the back fence", seen_at: at(5) }]]);
			expect(await sightings.activeAlerts(1, { now })).toEqual([]);
		});
	});
	test("a stranger rule matches by label, scoped to a camera", () => {
		const r = { subject_id: null, label: "stranger", device_serial: "T8213D", zone: null };
		expect(sightings.matches(r, { label: "stranger", device_serial: "T8213D" })).toBe(true);
		expect(sightings.matches(r, { label: "stranger", device_serial: "T8171B" })).toBe(false);
		expect(sightings.matches(r, { label: "Ross", device_serial: "T8213D" })).toBe(false);
	});
});

test("removing a subject deletes their sightings and rules", async () => {
	pool.query.mockResolvedValueOnce([[{ id: 7, uuid: "s-wynter" }]]).mockResolvedValue([{}]);
	await sightings.removeSubject("s-wynter");
	const sql = pool.query.mock.calls.map((c) => c[0]);
	expect(sql).toEqual(expect.arrayContaining([expect.stringMatching(/^DELETE FROM athena_sighting WHERE subject_id/), expect.stringMatching(/^DELETE FROM athena_sighting_rule WHERE subject_id/)]));
});

test("sighting pages count the selected filter and return ten rows at the requested offset", async () => {
	pool.query.mockResolvedValueOnce([[{ total: 23 }]]).mockResolvedValueOnce([[]]);
	expect(await sightings.page({ filter: "stranger", page: 2 })).toEqual({ sightings: [], page: 2, pages: 3, total: 23 });
	const sql = pool.query.mock.calls;
	expect(sql[0][0]).toMatch(/s.label = \?/);
	expect(sql[0][1]).toEqual(["stranger"]);
	expect(sql[1][1]).toEqual(["stranger", 10, 10]);
});

test("another named entity can be added to the same camera frame", async () => {
	const frame = "gs://athena-security-media/sightings/a.jpg";
	pool.query.mockResolvedValueOnce([[{ uuid: "source", frame_uri: frame, event_id: "e1", event_kind: "motion", device_serial: "T8171B", device_name: "Backyard", seen_at: new Date(), zone: null }]])
		.mockResolvedValueOnce([[{ id: 7, uuid: "s-wynter", name: "Wynter", kind: "animal" }]])
		.mockResolvedValueOnce([[]]).mockResolvedValueOnce([{}]);
	expect(await sightings.addEntityFromSighting("source", "s-wynter")).toEqual({ id: expect.any(String), name: "Wynter" });
	const insert = pool.query.mock.calls.find((c) => /^INSERT INTO athena_sighting SET/.test(c[0]));
	expect(insert[1][0]).toMatchObject({ frame_uri: frame, subject_id: 7, label: "Wynter", kind: "animal" });
});

test("person pictures follow an explicit profile-scoped person key", async () => {
	pool.query.mockResolvedValueOnce([[{ id: 8, uuid: "s-ross", name: "Ross", kind: "person" }]])
		.mockResolvedValueOnce([[{ subject_id: 8, fact_uuid: "fact-ross" }]])
		.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
	const [ross] = await sightings.listSubjects(3, [{ id: "fact-ross", name: "Ross", photoUrl: "data:image/jpeg;base64,abc" }]);
	expect(ross).toMatchObject({ personFactUuid: "fact-ross", profilePhotoUrl: "data:image/jpeg;base64,abc" });
	expect(pool.query.mock.calls[1][1]).toEqual([3]);
});

test("a gallery person can only link to the caller's own remembered person", async () => {
	pool.query.mockResolvedValueOnce([[{ id: 8, uuid: "s-ross", kind: "person" }]]).mockResolvedValueOnce([[]]);
	await expect(sightings.linkPerson(3, "s-ross", "fact-other")).rejects.toMatchObject({ status: 404 });
	expect(pool.query.mock.calls[1][1]).toEqual([3, "fact-other"]);
	expect(pool.query.mock.calls.some((call) => /INSERT INTO athena_sighting_person_link/.test(call[0]))).toBe(false);
});

test("prune removes frames and rows past 30 days", async () => {
	pool.query.mockResolvedValueOnce([[{ frame_uri: "gs://athena-security-media/sightings/x.jpg" }]]).mockResolvedValueOnce([{ affectedRows: 4 }]);
	expect(await sightings.prune()).toEqual({ rows: 4, frames: 1 });
	const cutoff = pool.query.mock.calls[1][1][0];
	expect(Math.round((Date.now() - cutoff) / 86_400_000)).toBe(30);
});

test("the chat block says who it doesn't know rather than guessing", async () => {
	pool.query.mockResolvedValueOnce([[{ id: 7, uuid: "s-wynter", name: "Wynter", kind: "animal" }]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[]]);
	const block = await sightings.chatBlock("Bigfoot", { timeZone: "America/New_York" });
	expect(block).toMatch(/"Bigfoot" is not in the camera gallery/);
});

describe("teachFromSighting", () => {
	const S1 = "11111111-1111-4111-8111-111111111111";
	const S2 = "22222222-2222-4222-8222-222222222222";
	const S3 = "33333333-3333-4333-8333-333333333333";
	const frame = "gs://athena-security-media/sightings/2026-10-18/T8171B/f1.jpg";
	const dog = { id: 41, uuid: S1, subject_id: null, label: "unknown dog", kind: "animal", device_serial: "T8171B", device_name: "Backyard", frame_uri: frame };
	const wynter = { id: 7, uuid: "s-wynter", name: "Wynter", kind: "animal" };
	const sqlCalls = () => pool.query.mock.calls.map((c) => c[0]);
	beforeEach(() => {
		securityMedia.save.mockReset().mockResolvedValue({ id: "m-new" });
		securityMedia.open.mockReset().mockResolvedValue({ row: { type: "image", important: false } });
		securityMedia.setImportant.mockReset();
		securityMedia.remove.mockReset();
	});

	test("copies the frame into a kept, starred image, adds it as a reference and names only that row", async () => {
		pool.query
			.mockResolvedValueOnce([[dog]]) // the sighting
			.mockResolvedValueOnce([[wynter]]) // subjectRow
			.mockResolvedValueOnce([[{ n: 1 }]]) // photo count
			.mockResolvedValueOnce([[wynter]]) // addPhoto: subjectRow
			.mockResolvedValueOnce([[{ n: 1 }]]) // addPhoto: count
			.mockResolvedValue([{}]);
		const out = await sightings.teachFromSighting(1, S1, { subjectId: "s-wynter" });
		expect(out).toEqual({ subjectId: "s-wynter", name: "Wynter", created: false, photoAdded: true, photoNote: null, renamed: 1 });
		expect(securityMedia.save).toHaveBeenCalledWith(expect.objectContaining({ profileId: 1, serial: "T8171B", deviceName: "Backyard", type: "image" }));
		expect(securityMedia.save.mock.calls[0][0].buf.toString()).toBe("frame:athena-security-media/sightings/2026-10-18/T8171B/f1.jpg");
		expect(securityMedia.setImportant).toHaveBeenCalledWith("m-new", true);
		const insert = pool.query.mock.calls.find((c) => /INSERT IGNORE INTO athena_sighting_subject_photo/.test(c[0]));
		expect(insert[1]).toEqual([7, "m-new", expect.any(Date)]);
		const update = pool.query.mock.calls.find((c) => /^UPDATE athena_sighting SET/.test(c[0]));
		expect(update[0]).toMatch(/subject_id IS NULL/);
		expect(update[1]).toEqual([7, "Wynter", "animal", [41]]);
	});

	test("a full subject still takes the name, says so, and copies nothing", async () => {
		pool.query.mockResolvedValueOnce([[dog]]).mockResolvedValueOnce([[wynter]]).mockResolvedValueOnce([[{ n: 3 }]]).mockResolvedValue([{}]);
		const out = await sightings.teachFromSighting(1, S1, { subjectId: "s-wynter" });
		expect(out.photoAdded).toBe(false);
		expect(out.photoNote).toMatch(/already has 3 reference photos/);
		expect(securityMedia.save).not.toHaveBeenCalled();
		expect(sqlCalls().some((q) => /^UPDATE athena_sighting SET/.test(q))).toBe(true);
	});

	test("a new name can correct the sighting's kind", async () => {
		pool.query
			.mockResolvedValueOnce([[dog]])
			.mockResolvedValueOnce([{}]) // INSERT subject
			.mockResolvedValueOnce([[{ id: 9, uuid: "s-new", name: "Biscuit", kind: "person" }]]) // subjectRow
			.mockResolvedValueOnce([[{ n: 0 }]])
			.mockResolvedValueOnce([[{ id: 9, uuid: "s-new", name: "Biscuit", kind: "person" }]])
			.mockResolvedValueOnce([[{ n: 0 }]])
			.mockResolvedValue([{}]);
		const out = await sightings.teachFromSighting(1, S1, { newSubject: { name: "Biscuit", kind: "person", description: "neighbour's beagle" } });
		expect(out).toEqual(expect.objectContaining({ name: "Biscuit", created: true, photoAdded: true }));
		const insert = pool.query.mock.calls.find((c) => /^INSERT INTO athena_sighting_subject SET/.test(c[0]));
		expect(insert[1][0]).toEqual(expect.objectContaining({ name: "Biscuit", kind: "person", description: "neighbour's beagle", created_by: 1 }));
	});

	test("a reserved name is refused before anything is written", async () => {
		pool.query.mockResolvedValueOnce([[dog]]);
		await expect(sightings.teachFromSighting(1, S1, { newSubject: { name: "Stranger 2" } })).rejects.toMatchObject({ status: 400 });
		expect(pool.query).toHaveBeenCalledTimes(1);
	});

	test("an already-named row or no choice is refused", async () => {
		pool.query.mockResolvedValueOnce([[{ ...dog, subject_id: 7 }]]);
		await expect(sightings.teachFromSighting(1, S1, { subjectId: "s-wynter" })).rejects.toMatchObject({ status: 409 });
		pool.query.mockResolvedValueOnce([[dog]]);
		await expect(sightings.teachFromSighting(1, S1, {})).rejects.toMatchObject({ status: 400 });
		expect(sqlCalls().some((q) => /^UPDATE/.test(q))).toBe(false);
		expect(securityMedia.save).not.toHaveBeenCalled();
	});

	test("other rows are renamed only when ticked, and never one from the same frame", async () => {
		const later = { ...dog, id: 42, uuid: S2, frame_uri: frame.replace("f1", "f2") };
		pool.query
			.mockResolvedValueOnce([[dog]])
			.mockResolvedValueOnce([[later]])
			.mockResolvedValueOnce([[wynter]])
			.mockResolvedValueOnce([[{ n: 3 }]])
			.mockResolvedValue([{}]);
		const out = await sightings.teachFromSighting(1, S1, { subjectId: "s-wynter", alsoIds: [S2] });
		expect(out.renamed).toBe(2);
		expect(pool.query.mock.calls.find((c) => /^UPDATE athena_sighting SET/.test(c[0]))[1]).toEqual([7, "Wynter", "animal", [41, 42]]);

		pool.query.mockReset();
		const sameFrame = { ...dog, id: 43, uuid: S3, label: "unknown dog" };
		pool.query.mockResolvedValueOnce([[dog]]).mockResolvedValueOnce([[sameFrame]]);
		await expect(sightings.teachFromSighting(1, S1, { subjectId: "s-wynter", alsoIds: [S3] })).rejects.toMatchObject({ status: 400 });
		expect(sqlCalls().some((q) => /^UPDATE/.test(q))).toBe(false);
	});

	test("a failed copy for a brand-new name removes that name again", async () => {
		pool.query
			.mockResolvedValueOnce([[dog]])
			.mockResolvedValueOnce([{}])
			.mockResolvedValueOnce([[{ id: 9, uuid: "s-new", name: "Biscuit", kind: "animal" }]])
			.mockResolvedValueOnce([[{ n: 0 }]])
			.mockResolvedValue([[{ id: 9, uuid: "s-new" }]]);
		securityMedia.save.mockRejectedValueOnce(new Error("bucket down"));
		await expect(sightings.teachFromSighting(1, S1, { newSubject: { name: "Biscuit" } })).rejects.toThrow("bucket down");
		expect(sqlCalls()).toEqual(expect.arrayContaining([expect.stringMatching(/^DELETE FROM athena_sighting_subject WHERE id/)]));
		expect(sqlCalls().some((q) => /^UPDATE athena_sighting SET/.test(q))).toBe(false);
	});
});
