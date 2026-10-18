jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./llm", () => ({ generateJson: jest.fn() }));
jest.mock("./securityMedia", () => ({ open: jest.fn(), setImportant: jest.fn() }));
const pool = require("../helpers/db");
const sightings = require("./sightings");

const saved = [];
beforeEach(() => {
	saved.length = 0;
	pool.query.mockReset();
	sightings._setStorage({ bucket: (b) => ({ file: (n) => ({ save: jest.fn(async () => saved.push(`${b}/${n}`)), delete: jest.fn(async () => {}) }) }) });
});

const gallery = [
	{ id: "s-wynter", name: "Wynter", kind: "animal", description: "black lab", photos: [] },
	{ id: "s-ross", name: "Ross", kind: "person", description: null, photos: [] },
];
const zones = [{ name: "outside the back fence" }, { name: "inside the fence" }];

describe("cleanSubjects", () => {
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
