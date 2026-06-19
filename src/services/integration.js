const { v4: uuidv4 } = require("uuid");
const pool = require("../helpers/db");
const config = require("../config");
const { encrypt, decrypt } = require("../helpers/crypto");
const {
	getProfileByGoogleId,
	withTransaction,
} = require("./parent-helpers");
const { getFamilyForProfile } = require("./family");
const { getProfileByEmail } = require("./profile");
const familyChores = require("./familyChores");
const choreSuggestions = require("./choreSuggestions");
const ghostChoreSuggestions = require("./ghostChoreSuggestions");
const memory = require("./memory");
const geminiService = require("./gemini");
const {
	FAMILY_CHORES_FUNCTION_DECLARATIONS,
	executeFamilyChoresTool,
	summarizeEndpoints,
} = require("./familyChoresTools");

/**
 * External-integration service (Family Chores app).
 *
 * Connect is partner-initiated and email-based:
 *   1. The Family Chores backend POSTs its scoped API token to the PUBLIC
 *      connect endpoint, authenticated with the shared partner secret.
 *   2. Athena reads /me, requires a parent/admin role, and matches the
 *      owner's email to an existing Athena profile — creating a new Athena
 *      account if none exists.
 *   3. The (encrypted) token is stored on an `integration_link` for that
 *      profile, so Athena can answer chore/coin questions.
 */

const PROVIDER_FAMILY_CHORES = "family_chores";
const SUPPORTED_PROVIDERS = new Set([PROVIDER_FAMILY_CHORES]);

function assertProvider(provider) {
	if (!SUPPORTED_PROVIDERS.has(provider)) {
		const err = new Error(`Unsupported integration provider: ${provider}`);
		err.status = 400;
		throw err;
	}
}

function httpError(message, status) {
	const err = new Error(message);
	err.status = status;
	return err;
}

/**
 * Resolve the acting Athena user (from req.user) to a profile id + family.
 * Used by the authenticated status/disconnect endpoints.
 */
async function resolveActingProfile(user) {
	if (!user) throw httpError("Authentication required", 401);
	if (user.kind === "child") {
		const [rows] = await pool.query(
			`SELECT p.id AS profile_id, cp.family_id
       FROM profile p
       LEFT JOIN child_profiles cp ON cp.profile_id = p.id
       WHERE p.uuid = ? LIMIT 1;`,
			[user.profileUuid]
		);
		if (!rows.length) throw httpError("Profile not found", 404);
		return {
			profileId: rows[0].profile_id,
			familyId: rows[0].family_id || user.familyId || null,
		};
	}
	const profile = await getProfileByGoogleId(user.googleId);
	const family = await getFamilyForProfile(profile.id);
	return { profileId: profile.id, familyId: family ? family.id : null };
}

/** Constant-time-ish compare for the partner secret. */
function verifyPartnerSecret(provided) {
	const expected = config.FAMILY_CHORES_PARTNER_SECRET;
	if (!expected) {
		console.warn(
			"[integration] FAMILY_CHORES_PARTNER_SECRET is not set; allowing connect without partner auth (set it in production)."
		);
		return;
	}
	if (!provided || provided !== expected) {
		throw httpError("Invalid or missing partner credentials", 401);
	}
}

/** True if the Family Chores role is permitted to establish a link. */
function isAdminRole(role) {
	if (typeof role !== "string") return false;
	return config.FAMILY_CHORES_ADMIN_ROLES.includes(role.trim().toLowerCase());
}

/**
 * Find an Athena profile by email, or create a new parent account for it.
 * New accounts use a sentinel google_id (the codebase convention for
 * profiles without a real Google login) and get an owner family so they
 * behave like a normal parent account.
 */
async function findOrCreateProfileByEmail(email, displayName) {
	const normalized = String(email).trim().toLowerCase();
	const existing = await getProfileByEmail(normalized);
	if (existing) {
		return { profileId: existing.id, created: false };
	}

	const profileId = await withTransaction(async (conn) => {
		const profileUuid = uuidv4();
		const [pResult] = await conn.query(
			`INSERT INTO profile
         (uuid, google_id, email, full_name, has_guardian, is_guardian, is_teacher, profile_editing_locked)
       VALUES (?, ?, ?, ?, 0, 1, 0, 0);`,
			[
				profileUuid,
				`familychores:${normalized}`,
				normalized,
				typeof displayName === "string" && displayName.trim()
					? displayName.trim().slice(0, 120)
					: null,
			]
		);
		const newProfileId = pResult.insertId;

		// Give the new parent an owner family, mirroring normal signup.
		const familyUuid = uuidv4();
		const familyName = `${
			(displayName && displayName.trim()) || "My"
		}'s Family`;
		const [fResult] = await conn.query(
			`INSERT INTO families (uuid, name, created_by_profile_id) VALUES (?, ?, ?);`,
			[familyUuid, familyName.slice(0, 120), newProfileId]
		);
		await conn.query(
			`INSERT INTO family_members (family_id, profile_id, role, display_name, status)
       VALUES (?, ?, 'owner', ?, 'active');`,
			[fResult.insertId, newProfileId, displayName || null]
		);

		return newProfileId;
	});

	return { profileId, created: true };
}

/** Insert or replace the active link for (profile, provider). */
async function upsertLink({
	profileId,
	familyId,
	provider,
	identity,
	token,
	baseUrl,
	scopes,
}) {
	const encrypted = encrypt(token);
	const uuid = uuidv4();
	await pool.query(
		`INSERT INTO integration_link
       (uuid, provider, profile_id, family_id, external_user_id,
        external_player_id, external_family_id, external_email, display_name,
        access_token, base_url, scopes, status, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW())
     ON DUPLICATE KEY UPDATE
       family_id = VALUES(family_id),
       external_user_id = VALUES(external_user_id),
       external_player_id = VALUES(external_player_id),
       external_family_id = VALUES(external_family_id),
       external_email = VALUES(external_email),
       display_name = VALUES(display_name),
       access_token = VALUES(access_token),
       base_url = VALUES(base_url),
       scopes = VALUES(scopes),
       status = 'active',
       deleted_at = NULL,
       last_synced_at = NOW();`,
		[
			uuid,
			provider,
			profileId,
			familyId,
			identity.externalUserId,
			identity.playerId,
			identity.externalFamilyId,
			identity.email,
			identity.displayName,
			encrypted,
			baseUrl || null,
			scopes || null,
		]
	);
}

/**
 * PUBLIC connect path (partner-initiated). The Family Chores backend calls
 * this with its API token + the shared partner secret. We verify the token,
 * require a parent/admin role, match/create an Athena account by the owner's
 * email, and persist the link.
 */
async function connectFamilyChores({ partnerSecret, apiToken, baseUrl, scopes }) {
	const provider = PROVIDER_FAMILY_CHORES;

	verifyPartnerSecret(partnerSecret);

	if (typeof apiToken !== "string" || !apiToken.trim()) {
		throw httpError("Missing Family Chores API token", 400);
	}

	// Verify the token + resolve who it represents.
	let identity;
	try {
		identity = await familyChores.resolveIdentity({
			token: apiToken.trim(),
			baseUrl,
		});
	} catch (err) {
		if (err.status === 401 || err.status === 403) {
			throw httpError("Family Chores rejected the API token", 400);
		}
		throw httpError(`Could not reach Family Chores: ${err.message}`, 502);
	}

	// Only a Family Chores parent/admin may link.
	if (!isAdminRole(identity.role)) {
		throw httpError(
			`Only a Family Chores parent/admin can connect Athena (token role: ${
				identity.role || "unknown"
			})`,
			403
		);
	}

	if (!identity.email) {
		throw httpError(
			"Family Chores did not return an email for this account, so it can't be linked to Athena",
			400
		);
	}
	if (!identity.playerId) {
		throw httpError(
			"Could not resolve a Family Chores player for this token",
			400
		);
	}

	// Match or create the Athena account by email.
	const { profileId, created } = await findOrCreateProfileByEmail(
		identity.email,
		identity.displayName
	);
	const family = await getFamilyForProfile(profileId);

	await upsertLink({
		profileId,
		familyId: family ? family.id : null,
		provider,
		identity,
		token: apiToken.trim(),
		baseUrl,
		scopes,
	});

	return {
		provider,
		connected: true,
		created_account: created,
		email: identity.email,
		display_name: identity.displayName,
		player_id: identity.playerId,
		family_name: identity.familyName,
	};
}

/** Fetch the active link row for a profile, or null. Token NOT decrypted. */
async function getActiveLinkRow(profileId, provider = PROVIDER_FAMILY_CHORES) {
	if (!profileId) return null;
	const [rows] = await pool.query(
		`SELECT * FROM integration_link
     WHERE profile_id = ? AND provider = ? AND status = 'active'
       AND deleted_at IS NULL
     LIMIT 1;`,
		[profileId, provider]
	);
	return rows[0] || null;
}

/** Public-facing status for the acting user (no secrets). */
async function getStatus(user, provider = PROVIDER_FAMILY_CHORES) {
	assertProvider(provider);
	const { profileId } = await resolveActingProfile(user);
	const row = await getActiveLinkRow(profileId, provider);
	if (!row) return { provider, connected: false };
	return {
		provider,
		connected: true,
		display_name: row.display_name,
		player_id: row.external_player_id,
		email: row.external_email,
		last_synced_at: row.last_synced_at,
		created_at: row.created_at,
	};
}

/**
 * PUBLIC (partner-initiated) disconnect. The Family Chores backend calls this
 * with the partner secret to sever a link it owns, identified by email,
 * playerId, or an apiToken (whose /me email/player we resolve). Revokes any
 * matching active Family Chores link(s).
 */
async function disconnectByPartner({ partnerSecret, email, playerId, apiToken, baseUrl }) {
	const provider = PROVIDER_FAMILY_CHORES;
	verifyPartnerSecret(partnerSecret);

	let targetEmail = typeof email === "string" ? email.trim().toLowerCase() : null;
	let targetPlayer = playerId != null ? String(playerId) : null;

	// If a token was supplied, resolve identity from it (no trust in caller-
	// supplied email/playerId needed).
	if (apiToken && (!targetEmail || !targetPlayer)) {
		try {
			const identity = await familyChores.resolveIdentity({
				token: String(apiToken).trim(),
				baseUrl,
			});
			targetEmail = targetEmail || (identity.email || "").toLowerCase() || null;
			targetPlayer = targetPlayer || identity.playerId || null;
		} catch {
			// Token may already be revoked; fall back to email/playerId if given.
		}
	}

	if (!targetEmail && !targetPlayer) {
		throw httpError("Provide an email, playerId, or apiToken to disconnect", 400);
	}

	const [result] = await pool.query(
		`UPDATE integration_link
       SET status = 'revoked', deleted_at = NOW()
     WHERE provider = ? AND deleted_at IS NULL
       AND (
         (? IS NOT NULL AND LOWER(external_email) = ?) OR
         (? IS NOT NULL AND external_player_id = ?)
       );`,
		[provider, targetEmail, targetEmail, targetPlayer, targetPlayer]
	);

	return { provider, disconnected: result.affectedRows > 0 };
}

/**
 * PUBLIC (partner-initiated) chore suggestions. The Family Chores backend
 * passes context with the partner secret; Athena (Gemini) returns chore ideas.
 */
async function suggestChores({ partnerSecret, child, existingChores, count, context }) {
	verifyPartnerSecret(partnerSecret);
	const suggestions = await choreSuggestions.generateChoreSuggestions({
		child,
		existingChores,
		count,
		context,
	});
	return { provider: PROVIDER_FAMILY_CHORES, suggestions };
}

/**
 * PUBLIC (partner-initiated) STRUCTURED ghost-chore suggestions. Family Chores
 * passes a sanitized context payload with the partner secret; Athena (Gemini)
 * returns age-aware, role-aware, parent-approval-friendly suggestions plus meta.
 */
async function suggestGhostChores({ partnerSecret, ...context }) {
	verifyPartnerSecret(partnerSecret);
	const { suggestions, meta } =
		await ghostChoreSuggestions.generateGhostChoreSuggestions(context);
	return { provider: PROVIDER_FAMILY_CHORES, suggestions, meta };
}

const SUGGESTION_TYPE_LABELS = {
	repeat: "routine",
	next_step: "next-step",
	skill_building: "skill-building",
	novelty: "fresh, new",
};

/** Compose a short, parent-friendly preference note from an acceptance signal. */
function composePreferenceNote(displayName, signal = {}) {
	const who = (displayName || "This child").trim();
	const typeLabel = SUGGESTION_TYPE_LABELS[signal.suggestionType] || null;
	const pillar = typeof signal.pillar === "string" ? signal.pillar.trim() : "";
	const category = typeof signal.category === "string" ? signal.category.trim() : "";
	const focus = pillar || category;
	const parts = [`${who} recently took on`];
	parts.push(typeLabel ? `a ${typeLabel} chore` : "a suggested chore");
	if (focus) parts.push(`focused on ${focus}`);
	let note = parts.join(" ") + ".";
	if (signal.difficulty === "hard" || signal.suggestionType === "skill_building") {
		note += " Seems ready for a bit more of a challenge.";
	}
	return note.slice(0, 280);
}

/**
 * PUBLIC (partner-initiated): record a distilled, family-visible preference in
 * the linked Athena child's memory when the family accepts an Athena chore
 * suggestion. Best-effort and idempotent (single upsert slot). No-ops gracefully
 * (remembered:false) when there is no linked Athena child for the player.
 */
async function rememberPreference({ partnerSecret, email, playerId, signal }) {
	verifyPartnerSecret(partnerSecret);
	if (playerId == null || String(playerId).trim() === "") {
		throw httpError("A Family Chores playerId is required", 400);
	}
	const targetPlayer = String(playerId).trim();

	let family;
	try {
		({ family } = await resolveParentLinkByEmail(email));
	} catch {
		return { provider: PROVIDER_FAMILY_CHORES, remembered: false, reason: "parent_not_linked" };
	}
	if (!family) {
		return { provider: PROVIDER_FAMILY_CHORES, remembered: false, reason: "no_family" };
	}

	const children = await listFamilyChildrenWithLinks(family.id);
	const child = children.find((c) => c.linkedPlayerId === targetPlayer);
	if (!child) {
		return { provider: PROVIDER_FAMILY_CHORES, remembered: false, reason: "child_not_linked" };
	}

	const value = composePreferenceNote(child.displayName, signal || {});
	await memory.upsertMemoryForProfile(child.profileId, family.id, {
		category: "preference",
		key: "family_chores_preferences",
		value,
		visibility: "family",
		source: "ai",
		confidence: 60,
	});

	return { provider: PROVIDER_FAMILY_CHORES, remembered: true, child_uuid: child.childUuid };
}

/** Soft-disconnect the active link for the acting user. */
async function disconnect(user, provider = PROVIDER_FAMILY_CHORES) {
	assertProvider(provider);
	const { profileId } = await resolveActingProfile(user);
	const [result] = await pool.query(
		`UPDATE integration_link
       SET status = 'revoked', deleted_at = NOW()
     WHERE profile_id = ? AND provider = ? AND deleted_at IS NULL;`,
		[profileId, provider]
	);
	return { provider, disconnected: result.affectedRows > 0 };
}

/** Decrypt + return usable credentials for a profile's active link, or null. */
async function getUsableCredentials(profileId, provider = PROVIDER_FAMILY_CHORES) {
	const row = await getActiveLinkRow(profileId, provider);
	if (!row) return null;
	let token;
	try {
		token = decrypt(row.access_token);
	} catch (err) {
		console.error("[integration] Failed to decrypt access token:", err.message);
		return null;
	}
	return {
		token,
		baseUrl: row.base_url,
		playerId: row.external_player_id,
		displayName: row.display_name,
	};
}

/** Keywords that signal a message is about Family Chores data. */
const FC_KEYWORDS =
	/\b(chore|chores|task|tasks|coin|coins|allowance|balance|reward|rewards|achievement|achievements|to.?do)\b/i;

/** Does this user message look like it needs live Family Chores data? */
function messageNeedsFamilyChores(message) {
	return typeof message === "string" && FC_KEYWORDS.test(message);
}

function formatChore(c) {
	const coins = Number.isFinite(c.coinValue) ? ` (${c.coinValue} coins)` : "";
	let when = " — no due date";
	if (c.completedAt) {
		when = ` — completed ${String(c.completedAt).slice(0, 10)}`;
	} else if (c.dueDate) {
		when = ` — due ${c.dueDate}`;
	}
	const categories =
		Array.isArray(c.categories) && c.categories.length
			? ` [category: ${c.categories
					.map((cat) => (typeof cat === "string" ? cat : cat?.name))
					.filter(Boolean)
					.join(", ")}]`
			: "";
	const status = c.status ? ` {${c.status}}` : "";
	const recurring = c.projected ? " (recurring — upcoming occurrence)" : "";
	return `- ${c.title || "Untitled chore"}${coins}${when}${categories}${status}${recurring}`;
}

function todayIso() {
	return new Date().toISOString().slice(0, 10);
}

/** Human-readable label for a get_player_chores tool call's arguments. */
function describeChoreQuery(args = {}) {
	const parts = [];
	if (args.status === "completed") parts.push("completed");
	else if (args.status === "open") parts.push("to-do");
	if (args.from || args.to) {
		parts.push(`${args.from || "…"} → ${args.to || "…"}`);
	} else if (args.range) {
		parts.push(args.range);
	}
	if (args.category) parts.push(`category "${args.category}"`);
	const label = parts.join(", ");
	return label ? `Chores (${label})` : "Chores";
}

/** Turn collected tool results into grounding body lines (no header/date). */
function formatToolResults(collected) {
	const lines = [];
	for (const { tool, args, result } of collected) {
		if (!result || result.error) continue;
		if (tool === "get_player_coins") {
			const bits = [`balance: ${result.coinBalance ?? "unknown"} coins`];
			if (Number.isFinite(result.pendingCoins)) {
				bits.push(`${result.pendingCoins} pending`);
			}
			lines.push(`Coins — ${bits.join(", ")}.`);
		} else if (tool === "get_player_chores") {
			const chores = Array.isArray(result.chores) ? result.chores : [];
			const label = describeChoreQuery(args);
			if (!chores.length) {
				lines.push(`${label}: none.`);
			} else {
				lines.push(`${label}:`);
				chores.forEach((c) => lines.push(formatChore(c)));
			}
		} else if (tool === "call_family_chores_api") {
			// Arbitrary documented endpoint — if it returned a chore list, format
			// it nicely; otherwise include the raw JSON (bounded) for grounding.
			const chores = Array.isArray(result.chores) ? result.chores : null;
			lines.push(`API ${args.path}:`);
			if (chores) {
				if (!chores.length) lines.push("- none");
				else chores.forEach((c) => lines.push(formatChore(c)));
			} else {
				lines.push(JSON.stringify(result).slice(0, 1500));
			}
		}
	}
	return lines;
}

/** Wrap grounding body lines with the standard header + today's date. */
function groundingBlock(name, today, bodyLines) {
	if (!bodyLines.length) return null;
	return (
		`Live data from ${name}'s Family Chores account (use it to answer ` +
		`questions about chores and coins; do not invent values). Dates are ` +
		`YYYY-MM-DD; use "Today's date" below to resolve "today"/"tomorrow":\n` +
		`Today's date is ${today}.\n${bodyLines.join("\n")}`
	);
}

/**
 * Deterministically fetch the player's open chores and build the authoritative
 * "what's still to do / what's next" block. This does NOT rely on the model
 * choosing the right query — "next chore" is computed in code: the earliest
 * open chore due today or earlier (or with no due date). Future-dated chores
 * are listed separately and are only "next" when nothing is due now. Returns
 * an array of grounding lines (possibly empty on error).
 */
async function buildToDoNowLines(creds, today) {
	const opts = { token: creds.token, baseUrl: creds.baseUrl };
	let chores;
	try {
		chores =
			(await familyChores.getChores(
				creds.playerId,
				{ range: "all", status: "open" },
				opts
			)) || [];
	} catch (err) {
		console.warn("[integration] open-chores fetch failed:", err.message);
		return [];
	}

	const byDueAsc = (a, b) =>
		String(a.dueDate || "").localeCompare(String(b.dueDate || ""));
	const toDoNow = chores
		.filter((c) => !c.dueDate || c.dueDate <= today)
		.sort(byDueAsc);
	const future = chores
		.filter((c) => c.dueDate && c.dueDate > today)
		.sort(byDueAsc);

	const lines = [];
	if (toDoNow.length) {
		lines.push(
			`The next chore to do is: ${toDoNow[0].title || "Untitled chore"}. ` +
				`(This is the earliest chore that is not complete and not in the ` +
				`future — present it neutrally as simply the next thing to do.)`
		);
		lines.push("All chores still to do, earliest first (due today or earlier, or no due date):");
		toDoNow.forEach((c) => lines.push(formatChore(c)));
	} else {
		lines.push("Chores still to do — none due now. 🎉");
	}
	if (future.length) {
		lines.push(
			"Later/upcoming chores (FUTURE days — NOT the next chore unless nothing above is due now):"
		);
		future.forEach((c) => lines.push(formatChore(c)));
	}
	return lines;
}

/**
 * Let Gemini decide which Family Chores calls best answer the question, using
 * typed function-calling tools projected from the public API's OpenAPI spec.
 * Runs a bounded tool-calling loop (no JSON-mode here), executes each call
 * with the user's scoped token, and returns a grounding block built from the
 * results — or null if the model asked for nothing or the loop failed.
 */
async function gatherFamilyChoresContextViaTools(message, creds) {
	const today = todayIso();
	const name = creds.displayName || "the user";
	const opts = { token: creds.token, baseUrl: creds.baseUrl };
	const tools = [{ functionDeclarations: FAMILY_CHORES_FUNCTION_DECLARATIONS }];

	// Pull the live API docs so the model can build its own request for anything
	// the typed tools don't cover. Best-effort: without it, the generic
	// call_family_chores_api tool simply can't validate and won't be used.
	let spec = null;
	try {
		spec = await familyChores.getOpenApiSpec(opts);
	} catch (err) {
		console.warn("[integration] OpenAPI spec fetch failed:", err.message);
	}
	const catalog = spec ? summarizeEndpoints(spec) : "";

	const instruction =
		`You can fetch ${name}'s live Family Chores data with the provided tools to ` +
		`answer their question. Today's date is ${today}. Prefer get_player_chores ` +
		`and get_player_coins. If the question needs something they don't cover, ` +
		`use call_family_chores_api with a path chosen from this catalog of ` +
		`documented GET endpoints:\n${catalog || "(catalog unavailable)"}\n\n` +
		`IMPORTANT — "next chore", "what should I do next", or "what's left": this ` +
		`means the soonest chore that is NOT complete and NOT in the future. Fetch ` +
		`open chores (status=open, range=all) and pick the earliest one whose due ` +
		`date is today or earlier, or that has no due date. Only fall back to a ` +
		`future-dated chore if nothing is due today or earlier. Present it neutrally ` +
		`as simply the next thing to do — do not call it late, overdue, or past due.\n\n` +
		`Call whatever tools you need (you may call more than one), then stop. Do ` +
		`not write a prose answer in this step — only make tool calls.`;
	const contents = [
		{ role: "user", parts: [{ text: instruction }] },
		{ role: "user", parts: [{ text: `Question: "${message}"` }] },
	];

	const collected = [];
	const MAX_HOPS = 4;
	for (let hop = 0; hop < MAX_HOPS; hop += 1) {
		const response = await geminiService.generateContentRaw(contents, { tools });
		const calls = response.functionCalls || [];
		const modelContent = response.candidates?.[0]?.content;
		if (modelContent) contents.push(modelContent);
		if (!calls.length) break;

		const responseParts = [];
		for (const call of calls) {
			let result;
			try {
				result = await executeFamilyChoresTool(call.name, call.args || {}, {
					creds,
					spec,
				});
			} catch (err) {
				result = { error: err.message };
			}
			collected.push({ tool: call.name, args: call.args || {}, result });
			responseParts.push({
				functionResponse: { name: call.name, response: { result } },
			});
		}
		contents.push({ role: "user", parts: responseParts });
	}

	// Always ground "what's next / still to do" deterministically, regardless of
	// which queries the model chose — so it can't surface a future chore as the
	// next one just because that's what it happened to fetch.
	const toDoLines = await buildToDoNowLines(creds, today);
	const toolLines = formatToolResults(collected);
	const bodyLines = [...toDoLines, ...toolLines];
	return groundingBlock(name, today, bodyLines);
}

/**
 * Build a compact, plain-text snapshot of the user's Family Chores data to
 * inject into the AI system prompt. Returns null when the user has no link
 * or the data can't be fetched. Best-effort: a failure in one call does not
 * sink the others.
 *
 * Pulls three windows so Athena can answer the full range of chore questions:
 * open chores from today onward (with recurring occurrences projected by the
 * API — covers "today", "tomorrow", and category questions) and chores
 * completed in the last week. Each chore carries its due/completed date and
 * categories so the model can filter by day or category itself.
 */
async function buildFamilyChoresContext(profileId, options = {}) {
	const creds = await getUsableCredentials(profileId, PROVIDER_FAMILY_CHORES);
	if (!creds || !creds.playerId) return null;

	// Preferred path: let the model pick the best API calls for this question
	// via function-calling tools. Falls through to the fixed-window snapshot
	// below if it's disabled, errors, or yields nothing — so the grounded
	// answer never depends solely on the agentic path.
	if (options.message && config.FAMILY_CHORES_TOOLS_ENABLED) {
		try {
			const grounded = await gatherFamilyChoresContextViaTools(
				options.message,
				creds
			);
			if (grounded) {
				touchSynced(profileId, PROVIDER_FAMILY_CHORES);
				return grounded;
			}
		} catch (err) {
			console.warn(
				"[integration] Family Chores tool path failed, using snapshot:",
				err.message
			);
		}
	}

	const opts = { token: creds.token, baseUrl: creds.baseUrl };
	const today = todayIso();
	const name = creds.displayName || "the user";

	const [coinsResult, toDoLines, completedResult] = await Promise.all([
		familyChores.getCoins(creds.playerId, opts).catch(() => null),
		// Deterministic "what's still to do / what's next" — same authoritative
		// block the tool path uses, so both paths agree on the next chore.
		buildToDoNowLines(creds, today),
		familyChores
			.getChores(creds.playerId, { range: "last-week", status: "completed" }, opts)
			.catch(() => []),
	]);

	const bodyLines = [];

	if (coinsResult) {
		const parts = [`balance: ${coinsResult.coinBalance ?? "unknown"} coins`];
		if (Number.isFinite(coinsResult.pendingCoins)) {
			parts.push(`${coinsResult.pendingCoins} pending`);
		}
		bodyLines.push(`Coins — ${parts.join(", ")}.`);
	}

	bodyLines.push(...toDoLines);

	const completed = completedResult || [];
	if (completed.length) {
		bodyLines.push("Chores completed in the last week:");
		completed.forEach((c) => bodyLines.push(formatChore(c)));
	}

	const grounded = groundingBlock(name, today, bodyLines);
	if (!grounded) return null;

	touchSynced(profileId, PROVIDER_FAMILY_CHORES);
	return grounded;
}

async function touchSynced(profileId, provider = PROVIDER_FAMILY_CHORES) {
	await pool
		.query(
			`UPDATE integration_link SET last_synced_at = NOW()
       WHERE profile_id = ? AND provider = ? AND deleted_at IS NULL;`,
			[profileId, provider]
		)
		.catch(() => {});
}

// ===================================================================
// PER-CHILD LINKING (partner-initiated)
//
// After the parent connects (parent profile ↔ parent's own player), the
// Family Chores app enables Athena per child. Each enable links a Family
// Chores child *player* to an Athena child profile so that, when that child
// chats with Athena, grounding resolves THEIR coins/chores. The parent's
// already-stored family token is reused — no new token is minted.
// ===================================================================

/** Resolve the parent's profile + active link (token holder) by email. */
async function resolveParentLinkByEmail(email) {
	const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
	if (!normalized) throw httpError("Parent email is required", 400);
	const parent = await getProfileByEmail(normalized);
	if (!parent) {
		throw httpError("No Athena account is connected for this email", 400);
	}
	const link = await getActiveLinkRow(parent.id, PROVIDER_FAMILY_CHORES);
	if (!link) {
		throw httpError(
			"The parent account has no active Family Chores connection; connect first",
			400
		);
	}
	const family = await getFamilyForProfile(parent.id);
	if (!family) throw httpError("No Athena family for this account", 400);
	return { parent, link, family };
}

/** Children in a family, each with email + the Family Chores player they link to (if any). */
async function listFamilyChildrenWithLinks(familyId) {
	const [rows] = await pool.query(
		`SELECT cp.uuid AS child_uuid, cp.display_name, p.id AS profile_id,
		        p.email, il.external_player_id AS linked_player_id
		 FROM child_profiles cp
		 JOIN profile p ON p.id = cp.profile_id
		 LEFT JOIN integration_link il
		   ON il.profile_id = p.id AND il.provider = '${PROVIDER_FAMILY_CHORES}'
		      AND il.status = 'active' AND il.deleted_at IS NULL
		 WHERE cp.family_id = ? AND cp.deleted_at IS NULL
		 ORDER BY cp.created_at ASC;`,
		[familyId]
	);
	return rows.map((r) => ({
		childUuid: r.child_uuid,
		profileId: r.profile_id,
		displayName: r.display_name,
		email: r.email || null,
		linkedPlayerId: r.linked_player_id || null,
	}));
}

/**
 * PUBLIC (partner): list the parent's Athena children so Family Chores can let
 * the parent pick one to link (or decide to create a new one). If `childEmail`
 * is given and matches a child, it's flagged so the partner can auto-link.
 */
async function listAthenaChildren({ partnerSecret, email, childEmail }) {
	verifyPartnerSecret(partnerSecret);
	const { family } = await resolveParentLinkByEmail(email);
	const children = await listFamilyChildrenWithLinks(family.id);
	const normalizedChildEmail =
		typeof childEmail === "string" ? childEmail.trim().toLowerCase() : "";
	const matched = normalizedChildEmail
		? children.find(
				(c) => c.email && c.email.trim().toLowerCase() === normalizedChildEmail
		  ) || null
		: null;
	return {
		provider: PROVIDER_FAMILY_CHORES,
		matchedChildUuid: matched ? matched.childUuid : null,
		children: children.map((c) => ({
			childUuid: c.childUuid,
			displayName: c.displayName,
			email: c.email,
			linkedPlayerId: c.linkedPlayerId,
		})),
	};
}

/** Create a minimal Athena child profile inside an existing family. */
async function createChildInFamily({ familyId, createdByProfileId, displayName, email }) {
	const name =
		typeof displayName === "string" && displayName.trim()
			? displayName.trim().slice(0, 120)
			: "New Explorer";
	const normalizedEmail =
		typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
	return withTransaction(async (conn) => {
		const profileUuid = uuidv4();
		const [pResult] = await conn.query(
			`INSERT INTO profile
			   (uuid, google_id, email, full_name, has_guardian, is_guardian, is_teacher, profile_editing_locked)
			 VALUES (?, ?, ?, ?, 1, 0, 0, 1);`,
			[profileUuid, `child:${profileUuid}`, normalizedEmail, name]
		);
		const childProfileId = pResult.insertId;
		await conn.query(
			`INSERT INTO family_members (family_id, profile_id, role, display_name, status)
			 VALUES (?, ?, 'child', ?, 'active');`,
			[familyId, childProfileId, name]
		);
		const childUuid = uuidv4();
		await conn.query(
			`INSERT INTO child_profiles
			   (uuid, family_id, profile_id, display_name, created_by_profile_id)
			 VALUES (?, ?, ?, ?, ?);`,
			[childUuid, familyId, childProfileId, name, createdByProfileId || null]
		);
		return { profileId: childProfileId, childUuid, displayName: name };
	});
}

/**
 * PUBLIC (partner): link a Family Chores child player to an Athena child
 * profile, reusing the parent's stored token. The target child is resolved by
 * (in priority order) childEmail match, an explicit childUuid selection, or
 * `createNew` to provision a fresh Athena child.
 */
async function connectChildByPartner({
	partnerSecret,
	email,
	playerId,
	displayName,
	childUuid,
	childEmail,
	createNew,
}) {
	verifyPartnerSecret(partnerSecret);
	if (playerId == null || String(playerId).trim() === "") {
		throw httpError("A Family Chores playerId is required", 400);
	}
	const targetPlayer = String(playerId).trim();
	const { parent, link, family } = await resolveParentLinkByEmail(email);

	let token;
	try {
		token = decrypt(link.access_token);
	} catch (err) {
		console.error("[integration] Failed to decrypt parent token:", err.message);
		throw httpError("Stored Family Chores token could not be used", 500);
	}

	const children = await listFamilyChildrenWithLinks(family.id);
	const normalizedChildEmail =
		typeof childEmail === "string" ? childEmail.trim().toLowerCase() : "";

	let target = null;
	if (normalizedChildEmail) {
		target =
			children.find(
				(c) => c.email && c.email.trim().toLowerCase() === normalizedChildEmail
			) || null;
	}
	if (!target && childUuid) {
		target = children.find((c) => c.childUuid === childUuid) || null;
		if (!target) {
			throw httpError("Selected Athena child was not found in this family", 404);
		}
	}
	if (!target && createNew) {
		const created = await createChildInFamily({
			familyId: family.id,
			createdByProfileId: parent.id,
			displayName,
			email: normalizedChildEmail || null,
		});
		target = {
			childUuid: created.childUuid,
			profileId: created.profileId,
			displayName: created.displayName,
			email: normalizedChildEmail || null,
		};
	}
	if (!target) {
		// No email match and the partner did not pick/create — tell it to ask.
		const err = httpError("Select an existing Athena child or create a new one", 409);
		err.needsSelection = true;
		err.children = children.map((c) => ({
			childUuid: c.childUuid,
			displayName: c.displayName,
			email: c.email,
			linkedPlayerId: c.linkedPlayerId,
		}));
		throw err;
	}

	await upsertLink({
		profileId: target.profileId,
		familyId: family.id,
		provider: PROVIDER_FAMILY_CHORES,
		identity: {
			externalUserId: targetPlayer,
			playerId: targetPlayer,
			externalFamilyId: link.external_family_id || null,
			email: normalizedChildEmail || target.email || null,
			displayName:
				(typeof displayName === "string" && displayName.trim()) ||
				target.displayName ||
				null,
		},
		token,
		baseUrl: link.base_url,
		scopes: link.scopes,
	});

	return {
		provider: PROVIDER_FAMILY_CHORES,
		connected: true,
		child_uuid: target.childUuid,
		display_name: target.displayName,
		player_id: targetPlayer,
		created_account: Boolean(createNew && !normalizedChildEmail),
	};
}

/** PUBLIC (partner): remove a per-child link by Family Chores playerId. */
async function disconnectChildByPartner({ partnerSecret, email, playerId }) {
	verifyPartnerSecret(partnerSecret);
	if (playerId == null || String(playerId).trim() === "") {
		throw httpError("A Family Chores playerId is required", 400);
	}
	const targetPlayer = String(playerId).trim();
	const { family } = await resolveParentLinkByEmail(email);
	const [result] = await pool.query(
		`UPDATE integration_link il
		 JOIN child_profiles cp ON cp.profile_id = il.profile_id
		 SET il.status = 'revoked', il.deleted_at = NOW()
		 WHERE cp.family_id = ? AND il.provider = ?
		   AND il.external_player_id = ? AND il.deleted_at IS NULL;`,
		[family.id, PROVIDER_FAMILY_CHORES, targetPlayer]
	);
	return { provider: PROVIDER_FAMILY_CHORES, disconnected: result.affectedRows > 0 };
}

module.exports = {
	PROVIDER_FAMILY_CHORES,
	SUPPORTED_PROVIDERS,
	connectFamilyChores,
	disconnectByPartner,
	suggestChores,
	suggestGhostChores,
	rememberPreference,
	getStatus,
	disconnect,
	getUsableCredentials,
	touchSynced,
	messageNeedsFamilyChores,
	buildFamilyChoresContext,
	listAthenaChildren,
	connectChildByPartner,
	disconnectChildByPartner,
};
