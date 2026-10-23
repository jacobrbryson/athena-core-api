/**
 * Packages left at the door (docs/capabilities/packages.md, migration 0088).
 *
 * A sighting of kind "package" (services/sightings.js) opens a watch on that
 * camera. The webhook's answer asks the bridge to send a fresh frame from it
 * later — the bridge keeps the timer, because Cloud Run jobs can't reach the
 * tailnet bridge and core has no clock of its own to wake on — and when that
 * frame arrives (event kind "recheck") the vision model compares it with the
 * frame the package was first seen in: still there, gone, or can't tell.
 *
 *   still there  -> still_there_at is set (the package_waiting trigger reads
 *                   it) and, up to MAX_CHECKS, another re-check is asked for
 *   gone         -> collected; the next person seen on that camera since the
 *                   last check is named as who took it, as the cameras saw them
 *   can't tell   -> counted as a check and asked again, until MAX_CHECKS
 *
 * The model only perceives; who hears about it is decided by each person's
 * own "package" alert rule, in the trigger. No re-check frame is kept. A watch
 * whose re-check never came (the bridge restarted) lapses to 'unknown'.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../helpers/db");
const llm = require("./llm");

const HOUR = 3_600_000;
const FIRST_CHECK_MS = HOUR;
const NEXT_CHECK_MS = 2 * HOUR;
const MAX_CHECKS = 3;
/** A second package sighting on the same camera this soon is the same delivery. */
const SAME_DELIVERY_MS = 12 * HOUR;
/** A watch with no re-check this long after it was due lapses to 'unknown'. */
const LAPSE_MS = 3 * HOUR;
const RETENTION_DAYS = 30;

const COMPARE_SCHEMA = {
	type: "object",
	properties: {
		present: { type: "string", enum: ["yes", "no", "unsure"] },
		note: { type: "string" },
	},
	required: ["present"],
};

/** What the bridge is asked to do: send `deviceSn`'s fresh frame in `afterSeconds`. */
const ask = (w, ms) => ({ deviceSn: w.device_serial, watch: w.uuid, afterSeconds: Math.round(ms / 1000) });

/**
 * New sightings from one event. Opens a watch for each camera that saw a
 * package and isn't already watching one, and returns the re-checks to ask
 * the bridge for.
 */
async function onSightings(rows, { now = new Date() } = {}) {
	const packages = (rows || []).filter((r) => r.kind === "package");
	const asks = [];
	const seen = new Set();
	for (const s of packages) {
		if (seen.has(s.device_serial)) continue;
		seen.add(s.device_serial);
		const [open] = await pool.query(
			"SELECT id FROM athena_package_watch WHERE device_serial = ? AND status = 'waiting' AND first_seen_at >= ? LIMIT 1",
			[s.device_serial, new Date(now.getTime() - SAME_DELIVERY_MS)]
		);
		if (open.length) continue;
		const watch = {
			uuid: randomUUID(),
			sighting_uuid: s.uuid,
			device_serial: s.device_serial,
			device_name: s.device_name || null,
			zone: s.zone || null,
			where_text: s.where_text || null,
			first_seen_at: new Date(s.seen_at),
			frame_uri: s.frame_uri || null,
			check_at: new Date(now.getTime() + FIRST_CHECK_MS),
		};
		await pool.query("INSERT INTO athena_package_watch SET ?", [watch]);
		asks.push(ask(watch, FIRST_CHECK_MS));
	}
	return asks;
}

async function frameBase64(uri) {
	const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri || "");
	if (!m) return null;
	const sightings = require("./sightings");
	const [buf] = await sightings.storage().bucket(m[1]).file(m[2]).download();
	return buf.toString("base64");
}

/** Ask the vision model whether the package in the first frame is in the second. */
async function compare({ firstBase64, laterBase64, where }) {
	const prompt = `Two frames from the same home security camera. In the FIRST, a package was seen${where ? `: ${where}` : ""}.
Is that same package still there in the SECOND frame?
- present: "yes" if it is clearly still there, "no" if it is clearly gone, "unsure" if the view is dark, blocked or changed too much to tell.
- note: a few words on what you see where it was.
Return ONLY JSON matching: ${JSON.stringify(COMPARE_SCHEMA)}`;
	const { data } = await llm.generateJson({
		task: "vision",
		audience: "adult",
		schema: COMPARE_SCHEMA,
		contents: [{
			role: "user",
			parts: [
				{ text: prompt },
				{ text: "FIRST frame:" }, { inlineData: { mimeType: "image/jpeg", data: firstBase64 } },
				{ text: "SECOND frame:" }, { inlineData: { mimeType: "image/jpeg", data: laterBase64 } },
			],
		}],
		check: (d) => (["yes", "no", "unsure"].includes(d?.present) ? null : "present must be yes, no or unsure"),
	});
	return data.present;
}

/** Who the cameras saw on that camera between two instants — the likely collector. */
async function collectorBetween(serial, from, to) {
	const [rows] = await pool.query(
		`SELECT label FROM athena_sighting WHERE device_serial = ? AND kind = 'person' AND seen_at > ? AND seen_at <= ?
		 ORDER BY seen_at LIMIT 1`,
		[serial, from, to]
	);
	return rows[0]?.label || null;
}

/**
 * A re-check frame from the bridge. Returns the next re-checks to ask for
 * (possibly none). `compareWith` and `loadFrame` are for tests.
 */
async function recheck({ event, frame }, { now = new Date(), compareWith = compare, loadFrame = frameBase64 } = {}) {
	const uuid = String(event?.watch || "");
	const serial = String(event?.deviceSn || "");
	if (!/^[0-9a-f-]{36}$/.test(uuid)) return [];
	const [rows] = await pool.query("SELECT * FROM athena_package_watch WHERE uuid = ? AND device_serial = ?", [uuid, serial]);
	const w = rows[0];
	if (!w || w.status !== "waiting") return [];

	const checks = Number(w.checks_done) + 1;
	const lastCheck = w.checks_done > 0 ? new Date(w.check_at) : new Date(w.first_seen_at);
	let present = "unsure";
	if (frame) {
		const buf = Buffer.from(frame, "base64");
		const jpeg = buf.length && buf.length <= 5_000_000 && buf[0] === 0xff && buf[1] === 0xd8;
		const first = jpeg ? await loadFrame(w.frame_uri).catch(() => null) : null;
		if (first) {
			present = await compareWith({ firstBase64: first, laterBase64: buf.toString("base64"), where: w.where_text }).catch((err) => {
				console.warn("[packageWatch] compare failed:", err.message);
				return "unsure";
			});
		}
	}

	if (present === "no") {
		const by = await collectorBetween(serial, lastCheck, now).catch(() => null);
		await pool.query(
			"UPDATE athena_package_watch SET status = 'collected', checks_done = ?, resolved_at = ?, collected_by = ? WHERE id = ?",
			[checks, now, by, w.id]
		);
		return [];
	}
	const more = checks < MAX_CHECKS;
	const next = new Date(now.getTime() + NEXT_CHECK_MS);
	await pool.query(
		`UPDATE athena_package_watch SET checks_done = ?, check_at = ?,
			still_there_at = IF(? = 'yes', COALESCE(still_there_at, ?), still_there_at),
			status = IF(?, 'waiting', 'unknown'), resolved_at = IF(?, NULL, ?)
		 WHERE id = ?`,
		[checks, more ? next : now, present, now, more, more, now, w.id]
	);
	return more ? [ask(w, NEXT_CHECK_MS)] : [];
}

/**
 * Packages still sitting there: open watches confirmed present by a re-check,
 * for the package_waiting trigger. Household-level; the trigger filters by
 * each person's own rules.
 */
async function stillThere({ now = new Date() } = {}) {
	const [rows] = await pool.query(
		`SELECT * FROM athena_package_watch
		 WHERE status = 'waiting' AND still_there_at IS NOT NULL AND first_seen_at >= ?
		 ORDER BY first_seen_at DESC`,
		[new Date(now.getTime() - SAME_DELIVERY_MS * 2)]
	);
	return rows;
}

/** Package sightings around an instant — to tie a delivery email to the porch. */
async function sightingsNear(at, { beforeMs = 30 * 60_000, afterMs = 3 * HOUR } = {}) {
	const t = new Date(at).getTime();
	const [rows] = await pool.query(
		"SELECT * FROM athena_sighting WHERE kind = 'package' AND seen_at >= ? AND seen_at <= ? ORDER BY seen_at",
		[new Date(t - beforeMs), new Date(t + afterMs)]
	);
	return rows;
}

/** For chat: the porch watches from the last two days, newest first. */
async function chatLines({ now = new Date(), timeZone } = {}) {
	const [rows] = await pool.query(
		"SELECT * FROM athena_package_watch WHERE first_seen_at >= ? ORDER BY first_seen_at DESC LIMIT 6",
		[new Date(now.getTime() - 48 * HOUR)]
	);
	if (!rows.length) return null;
	const t = (at) => {
		try {
			return new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(new Date(at));
		} catch {
			return new Date(at).toISOString();
		}
	};
	const state = (w) =>
		w.status === "collected" ? `gone by ${t(w.resolved_at)}${w.collected_by ? ` (the camera next saw ${w.collected_by})` : ""}`
			: w.status === "unknown" ? "couldn't be re-checked"
				: w.still_there_at ? `still there at the last look, ${t(w.check_at && w.checks_done ? w.still_there_at : w.first_seen_at)}`
					: "not re-checked yet";
	return [
		"Packages the cameras saw left at the door (re-checked with a fresh camera frame):",
		...rows.map((w) => `- ${t(w.first_seen_at)} on the ${w.device_name || "camera"}${w.where_text ? `, ${w.where_text}` : ""}: ${state(w)}`),
	].join("\n");
}

/** Nightly: lapse watches whose re-check never came, and drop old ones. */
async function maintain({ now = new Date() } = {}) {
	const [lapsed] = await pool.query(
		"UPDATE athena_package_watch SET status = 'unknown', resolved_at = ? WHERE status = 'waiting' AND check_at < ?",
		[now, new Date(now.getTime() - LAPSE_MS)]
	);
	const [pruned] = await pool.query(
		"DELETE FROM athena_package_watch WHERE first_seen_at < ?",
		[new Date(now.getTime() - RETENTION_DAYS * 86_400_000)]
	);
	return { lapsed: lapsed.affectedRows || 0, pruned: pruned.affectedRows || 0 };
}

module.exports = { onSightings, recheck, compare, stillThere, sightingsNear, chatLines, maintain, MAX_CHECKS, FIRST_CHECK_MS, NEXT_CHECK_MS };
