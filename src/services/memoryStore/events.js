/**
 * Episodic memory: things that happened (memory_event).
 *
 * Kinds:
 *   conversation — a moment distilled from chat by background extraction
 *   photo        — a photo the user showed Athena (description only; the image
 *                  stays on the device, referenced by media_ref)
 *   news         — world-scope headline Athena read (profile_id NULL)
 *   observation  — something Athena saw through a camera
 *   drive        — a summarized car trip
 *   event        — something the user asked Athena to remember
 *   reflection   — Athena's own nightly synthesis of a day
 */
const { v4: uuidv4 } = require("uuid");
const pool = require("../../helpers/db");
const { embedInBackground, embedAndStore, textForEvent } = require("./embeddings");
const vectorIndex = require("./vectorIndex");

const KINDS = new Set(["conversation", "photo", "news", "observation", "drive", "event", "reflection"]);
const SCOPES = new Set(["personal", "family", "world"]);
const VISIBILITIES = new Set(["private", "family"]);

const clampImportance = (n) => Math.max(1, Math.min(10, Math.round(Number(n) || 5)));
const trim = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function toMysqlDate(value) {
	const d = value ? new Date(value) : new Date();
	if (Number.isNaN(d.getTime())) return toMysqlDate(null);
	return d.toISOString().slice(0, 19).replace("T", " ");
}

function publicEvent(row) {
	let metadata = row.metadata;
	if (typeof metadata === "string") {
		try {
			metadata = JSON.parse(metadata);
		} catch {
			metadata = null;
		}
	}
	return {
		uuid: row.uuid,
		kind: row.kind,
		scope: row.scope,
		title: row.title,
		content: row.content,
		occurred_at: row.occurred_at,
		importance: row.importance,
		source: row.source,
		visibility: row.visibility,
		media_ref: row.media_ref || null,
		metadata: metadata || null,
		recall_count: row.recall_count ?? 0,
		created_at: row.created_at,
	};
}

/**
 * Create an episodic memory. Returns the public event, or null when a
 * dedupe_key collides (e.g. a news item already stored).
 * `awaitEmbedding: true` embeds before returning (the photo flow wants the
 * memory recallable immediately); otherwise embedding happens in background.
 */
async function createEvent(input = {}, { awaitEmbedding = false } = {}) {
	const kind = KINDS.has(input.kind) ? input.kind : "event";
	const scope = SCOPES.has(input.scope) ? input.scope : input.profileId ? "personal" : "world";
	const content = trim(input.content, 8000);
	if (!content) throw new Error("A memory needs content");
	if (scope !== "world" && !input.profileId) throw new Error("A personal memory needs a profile");

	const uuid = uuidv4();
	const params = [
		uuid,
		scope === "world" ? null : input.profileId,
		input.familyId ?? null,
		scope,
		kind,
		trim(input.title, 200),
		content,
		toMysqlDate(input.occurredAt),
		clampImportance(input.importance),
		trim(input.source, 20) || "ai",
		VISIBILITIES.has(input.visibility) ? input.visibility : "private",
		input.sessionId ?? null,
		trim(input.mediaRef, 255),
		trim(input.dedupeKey, 40),
		input.metadata ? JSON.stringify(input.metadata) : null,
	];
	const [result] = await pool.query(
		`INSERT ${input.dedupeKey ? "IGNORE " : ""}INTO memory_event
       (uuid, profile_id, family_id, scope, kind, title, content, occurred_at, importance,
        source, visibility, session_id, media_ref, dedupe_key, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		params
	);
	if (!result?.affectedRows) return null; // dedupe hit

	const row = {
		id: result.insertId,
		uuid,
		profile_id: params[1],
		scope,
		kind,
		title: params[5],
		content,
		occurred_at: params[7],
		importance: params[8],
		source: params[9],
		visibility: params[10],
		media_ref: params[12],
		metadata: input.metadata || null,
		recall_count: 0,
		created_at: new Date(),
	};
	const embedItem = [{ type: "event", id: row.id, profileId: row.profile_id, text: textForEvent(row) }];
	if (awaitEmbedding) {
		await embedAndStore(embedItem).catch((err) =>
			console.warn("[memory] embedding failed; nightly backfill will retry:", err.message)
		);
	} else {
		embedInBackground(embedItem);
	}
	return publicEvent(row);
}

async function listEvents(profileId, { kind, limit = 50, before } = {}) {
	const conditions = ["profile_id = ?", "deleted_at IS NULL"];
	const params = [profileId];
	if (kind && KINDS.has(kind)) {
		conditions.push("kind = ?");
		params.push(kind);
	}
	if (before) {
		conditions.push("occurred_at < ?");
		params.push(toMysqlDate(before));
	}
	params.push(Math.min(Number(limit) || 50, 200));
	const [rows] = await pool.query(
		`SELECT * FROM memory_event WHERE ${conditions.join(" AND ")} ORDER BY occurred_at DESC LIMIT ?;`,
		params
	);
	return rows.map(publicEvent);
}

/** Soft-delete one of the profile's own events. */
async function deleteEvent(profileId, uuid) {
	const [rows] = await pool.query(
		`SELECT id FROM memory_event WHERE uuid = ? AND profile_id = ? AND deleted_at IS NULL LIMIT 1;`,
		[uuid, profileId]
	);
	if (!rows.length) throw new Error("Memory not found");
	await pool.query(`UPDATE memory_event SET deleted_at = NOW() WHERE id = ?;`, [rows[0].id]);
	vectorIndex.remove(profileId, "event", rows[0].id);
	return { success: true };
}

/** Rehearsal signal: recalled memories get stronger (see nightly consolidation). */
function markRecalled(eventIds) {
	if (!eventIds?.length) return;
	pool
		.query(
			`UPDATE memory_event SET recall_count = recall_count + 1, last_recalled_at = NOW()
       WHERE id IN (${eventIds.map(() => "?").join(", ")});`,
			eventIds
		)
		.catch(() => undefined);
}

module.exports = {
	KINDS,
	createEvent,
	listEvents,
	deleteEvent,
	markRecalled,
	publicEvent,
	toMysqlDate,
};
