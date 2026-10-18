jest.mock("../helpers/db", () => ({ query: jest.fn() }));
const pool = require("../helpers/db");
const media = require("./securityMedia");

const saved = [];
const deleted = [];
const fakeStorage = {
	bucket: (b) => ({
		file: (n) => ({
			save: jest.fn(async (buf, opts) => saved.push({ b, n, buf, opts })),
			delete: jest.fn(async () => deleted.push({ b, n })),
		}),
	}),
};
beforeEach(() => {
	saved.length = 0;
	deleted.length = 0;
	pool.query.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
	media._setStorage(fakeStorage);
});

test("a clip lands in the private bucket under a dated path and starts important", async () => {
	const out = await media.save({ profileId: 1, serial: "T8171ABC", deviceName: "Backyard", type: "clip", buf: Buffer.from("mp4"), durationSeconds: 15 });
	expect(saved[0].b).toBe("athena-security-media");
	expect(saved[0].n).toMatch(/^clips\/\d{4}-\d{2}-\d{2}\/T8171ABC\/[0-9a-f-]{36}\.mp4$/);
	expect(saved[0].opts.contentType).toBe("video/mp4");
	const row = pool.query.mock.calls[0][1][0];
	expect(row.important).toBe(1);
	expect(row.media_uri).toBe(`gs://athena-security-media/${saved[0].n}`);
	expect(out).toEqual(expect.objectContaining({ type: "clip", important: true, deviceName: "Backyard", durationSeconds: 15 }));
	expect(out).not.toHaveProperty("mediaUri");
});

test("an image is kept but not starred", async () => {
	const out = await media.save({ profileId: 1, serial: "T8213XYZ", type: "image", buf: Buffer.from("jpg") });
	expect(saved[0].n).toMatch(/^images\/.*\.jpg$/);
	expect(out.important).toBe(false);
});

test("a failed row insert removes the object it just wrote", async () => {
	pool.query.mockRejectedValue(new Error("db down"));
	await expect(media.save({ profileId: 1, serial: "T8213XYZ", type: "image", buf: Buffer.from("jpg") })).rejects.toThrow("db down");
	expect(deleted).toEqual([{ b: "athena-security-media", n: saved[0].n }]);
});

test("removing deletes the object then the row", async () => {
	pool.query.mockResolvedValueOnce([[{ uuid: "u", media_uri: "gs://athena-security-media/images/x.jpg", captured_at: new Date(), bytes: 3 }]]);
	expect(await media.remove("u")).toBe(true);
	expect(deleted).toEqual([{ b: "athena-security-media", n: "images/x.jpg" }]);
	expect(pool.query.mock.calls[1][0]).toMatch(/^DELETE FROM athena_security_media/);
});
