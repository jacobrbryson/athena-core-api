const crypto = require("crypto");
const pool = require("../../helpers/db");
const llm = require("../llm");

/**
 * Photo inventory (2026-11-18): a photo of the pantry, fridge, freezer or
 * counter becomes a list of what's there. The vision model reads item names
 * and rough amounts; code merges the photos of one place and replaces that
 * place's earlier list. The photos are never stored, and the prompt asks only
 * for food and household groceries — people and pets in frame are ignored.
 *
 * What was seen counts as "have" for the rest of Provisions (stock, coverage,
 * meal ideas, running low) while it is fresh: a fridge or counter changes in
 * days, a pantry or freezer in weeks.
 */

const PLACES = ["pantry", "fridge", "freezer", "counter"];
const ITEM_KINDS = ["proteins", "grains", "canned", "produce", "dairy", "frozen", "snacks", "drinks", "other"];
const FRESH_DAYS = { fridge: 10, counter: 7, pantry: 45, freezer: 90 };
const MAX_PHOTOS = 6;
const MAX_IMAGE_BASE64 = 6 * 1024 * 1024;
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_ITEMS = 120;
const DAY = 86400_000;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const norm = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function prompt(place) {
	return `This is a photo of a family's ${place === "counter" ? "kitchen counter or table" : place}, taken to keep track of what food they have.
List every distinct food, drink or cooking ingredient you can identify. For each:
  name: a short generic shopping-list name, singular where natural, brand only when it's the identity (e.g. "eggs", "Greek yogurt", "ketchup", "Cheerios");
  amount: what you can see, short (e.g. "1 dozen", "2 cans", "half full", "1 bag"), or "" if you can't tell;
  kind: one of ${ITEM_KINDS.join(", ")}.
Group identical items into one entry. Skip anything you can't identify with reasonable confidence, and skip packaging you can't read.
Ignore people, pets, hands and anything that isn't food, drink or an ingredient.
If you see no food at all, return an empty list.
Return ONLY JSON: { "items": [ { "name": "...", "amount": "...", "kind": "..." } ] }`;
}

function check(parsed) {
	if (!parsed || !Array.isArray(parsed.items)) return "needs an items array";
	return true;
}

/** The model's list, bounded and merged by name. */
function cleanItems(lists) {
	const byKey = new Map();
	for (const raw of lists.flat()) {
		const name = String(raw?.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
		const key = norm(name);
		if (!key || key.length < 2) continue;
		const kind = ITEM_KINDS.includes(raw.kind) ? raw.kind : "other";
		const amount = String(raw.amount || "").replace(/\s+/g, " ").trim().slice(0, 40) || null;
		const seen = byKey.get(key);
		// The same thing in two photos of one place is one item; keep the first amount.
		if (!seen) byKey.set(key, { name: name[0].toUpperCase() + name.slice(1), kind, amount });
		else if (!seen.amount && amount) seen.amount = amount;
		if (byKey.size >= MAX_ITEMS) break;
	}
	return [...byKey.values()];
}

function validate(body = {}) {
	const place = body.place;
	if (!PLACES.includes(place)) throw badRequest(`Choose where the photo was taken: ${PLACES.join(", ")}`);
	const photos = Array.isArray(body.photos) ? body.photos : [];
	if (!photos.length) throw badRequest("Add at least one photo");
	if (photos.length > MAX_PHOTOS) throw badRequest(`Up to ${MAX_PHOTOS} photos at a time`);
	for (const p of photos) {
		if (typeof p?.imageBase64 !== "string" || p.imageBase64.length < 100) throw badRequest("A photo is empty");
		if (p.imageBase64.length > MAX_IMAGE_BASE64) throw badRequest("A photo is too large — downscale to about 1280px first");
		if (!MIME_TYPES.has(p.mimeType)) throw badRequest("Photos must be JPEG, PNG or WebP");
	}
	return { place, photos, replace: body.replace !== false };
}

/**
 * Read the photos and store what's in them. With `replace` (the default) the
 * place's earlier items go: a new photo of the fridge is the fridge now.
 */
async function scan(profileId, body, now = new Date()) {
	const { place, photos, replace } = validate(body);
	const reads = [];
	for (const p of photos) {
		const { data } = await llm.generateJson({
			task: "vision",
			audience: "adult",
			contents: [{ role: "user", parts: [{ text: prompt(place) }, { inlineData: { mimeType: p.mimeType, data: p.imageBase64 } }] }],
			check,
		});
		reads.push(data.items);
	}
	const items = cleanItems(reads);
	const rows = items.map((i) => ({ uuid: crypto.randomUUID(), ...i }));
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		if (replace) await conn.query("DELETE FROM athena_pantry_item WHERE profile_id = ? AND place = ?", [profileId, place]);
		if (rows.length) {
			await conn.query("INSERT INTO athena_pantry_item (uuid, profile_id, place, name, kind, amount, seen_at) VALUES ?", [
				rows.map((r) => [r.uuid, profileId, place, r.name, r.kind, r.amount, now]),
			]);
		}
		await conn.commit();
	} catch (err) {
		await conn.rollback().catch(() => {});
		throw err;
	} finally {
		conn.release();
	}
	return { place, scannedAt: now.toISOString(), items: rows.map((r) => ({ uuid: r.uuid, name: r.name, kind: r.kind, amount: r.amount })) };
}

/** Everything seen, with each place's last scan and whether it's still fresh. */
async function seen(profileId, now = Date.now()) {
	const [rows] = await pool.query(
		"SELECT uuid, place, name, kind, amount, seen_at FROM athena_pantry_item WHERE profile_id = ? ORDER BY place, name LIMIT 600",
		[profileId]
	);
	return group(rows, now);
}

function group(rows, now = Date.now()) {
	const places = PLACES.map((place) => {
		const of = rows.filter((r) => r.place === place);
		const at = of.reduce((t, r) => Math.max(t, new Date(r.seen_at).getTime()), 0);
		return {
			place,
			scannedAt: at ? new Date(at).toISOString() : null,
			fresh: !!at && now - at <= FRESH_DAYS[place] * DAY,
			items: of.map((r) => ({ uuid: r.uuid, name: r.name, kind: r.kind, amount: r.amount || null })),
		};
	}).filter((p) => p.scannedAt);
	const fresh = places.filter((p) => p.fresh).flatMap((p) => p.items.map((i) => ({ ...i, place: p.place })));
	return { places, fresh };
}

async function remove(profileId, uuid) {
	const [result] = await pool.query("DELETE FROM athena_pantry_item WHERE profile_id = ? AND uuid = ?", [profileId, uuid]);
	if (!result.affectedRows) throw Object.assign(new Error("Unknown item"), { status: 404 });
	return { uuid, removed: true };
}

module.exports = { scan, seen, remove, group, cleanItems, validate, prompt, PLACES, FRESH_DAYS };
