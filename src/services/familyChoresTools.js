const familyChores = require("./familyChores");

/**
 * Gemini function-calling tools for the Family Chores Public API.
 *
 * These declarations are a hand-maintained projection of the OpenAPI spec
 * served at `${baseUrl}/api/docs/openapi.json` — specifically the read-only
 * player endpoints. Keeping them as typed function declarations (rather than
 * feeding the raw spec to the model at runtime) lets Gemini decide *which*
 * call and arguments best answer a question, while keeping every call
 * validated, cheap, and pinned to the user's own scoped token.
 *
 * Type strings are the canonical uppercase Gemini Schema values.
 */
const FAMILY_CHORES_FUNCTION_DECLARATIONS = [
	{
		name: "get_player_chores",
		description:
			"Look up the linked player's chores. Use this for any question about " +
			'what is left to do today, what is coming up tomorrow or later, what was ' +
			"completed in the past, or chores in a particular category (e.g. Vivacity). " +
			"Recurring chores are projected forward into future windows automatically. " +
			"For 'next chore' / 'what should I do next', use status=open with range=all " +
			"to get every open chore with its due date, then pick the earliest that is " +
			"due today or overdue (a future-dated chore is the next chore only when " +
			"nothing is due now).",
		parameters: {
			type: "OBJECT",
			properties: {
				range: {
					type: "STRING",
					enum: [
						"today",
						"tomorrow",
						"yesterday",
						"this-week",
						"last-week",
						"upcoming",
						"all",
					],
					description:
						"Relative time window. Ignored when from/to are provided. " +
						'Use "today" for what is left to do now, "tomorrow" for the next day, ' +
						'"last-week" for the previous week, "upcoming" for the next ~30 days.',
				},
				from: {
					type: "STRING",
					description: "Inclusive start date (YYYY-MM-DD). Overrides range.",
				},
				to: {
					type: "STRING",
					description: "Inclusive end date (YYYY-MM-DD). Overrides range.",
				},
				status: {
					type: "STRING",
					enum: ["open", "completed", "all"],
					description:
						'"open" = still to do, "completed" = already done (submitted/approved), ' +
						'"all" = either. Use "completed" for "what did I finish" questions.',
				},
				category: {
					type: "STRING",
					description:
						"Filter to a single category name, case-insensitive (e.g. Vivacity).",
				},
			},
		},
	},
	{
		name: "get_player_coins",
		description:
			"Get the linked player's coin balance and any pending (unapproved) coins.",
		parameters: { type: "OBJECT", properties: {} },
	},
	{
		name: "call_family_chores_api",
		description:
			"Escape hatch for questions the other tools don't cover. Make a GET " +
			"request to ANY documented Family Chores API endpoint. First review the " +
			"endpoint catalog (provided in the instructions) to choose the right path " +
			"and query parameters, then pass a root-relative path. The request is " +
			"authenticated as the current player automatically — never include a host, " +
			"token, or scheme. Example: /api/v1/players/123/chores?range=this-week&status=completed",
		parameters: {
			type: "OBJECT",
			properties: {
				path: {
					type: "STRING",
					description:
						"Root-relative path starting with /api/, including any query string. " +
						"Must match one of the documented GET endpoints.",
				},
			},
			required: ["path"],
		},
	},
];

/** Convert an OpenAPI path template to an anchored regex (`{id}` → `[^/]+`). */
function pathTemplateToRegex(template) {
	const escaped = template
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\\\{[^/}]+\\\}/g, "[^/]+");
	return new RegExp(`^${escaped}$`);
}

/**
 * From a parsed OpenAPI spec, build the list of documented GET path matchers.
 * Used to confine the generic `call_family_chores_api` tool to real endpoints.
 */
function buildAllowedGetPaths(spec) {
	const paths = spec && spec.paths ? spec.paths : {};
	return Object.entries(paths)
		.filter(([, methods]) => methods && methods.get)
		.map(([template]) => ({ template, regex: pathTemplateToRegex(template) }));
}

/** Is `path` (sans query string) one of the documented GET endpoints? */
function isAllowedGetPath(path, allowed) {
	const justPath = String(path).split("?")[0];
	return allowed.some((entry) => entry.regex.test(justPath));
}

/**
 * Compact, model-readable catalog of the documented GET endpoints so the model
 * can "review the docs" and build its own request without us dumping the full
 * spec. One line per endpoint: method, path, summary, and query params.
 */
function summarizeEndpoints(spec) {
	const paths = spec && spec.paths ? spec.paths : {};
	const lines = [];
	for (const [template, methods] of Object.entries(paths)) {
		const op = methods && methods.get;
		if (!op) continue;
		const query = Array.isArray(op.parameters)
			? op.parameters
					.filter((p) => p.in === "query")
					.map((p) => {
						const en = p.schema && p.schema.enum;
						return en ? `${p.name}=${en.join("|")}` : p.name;
					})
			: [];
		const qs = query.length ? ` ?${query.join("&")}` : "";
		lines.push(`GET ${template}${qs} — ${op.summary || ""}`.trim());
	}
	return lines.join("\n");
}

/**
 * Execute one tool call against the Family Chores API using the player's own
 * scoped credentials. `creds` is the decrypted link from getUsableCredentials
 * ({ token, baseUrl, playerId, displayName }). Returns a plain JSON-able value
 * suitable for a Gemini functionResponse.
 */
async function executeFamilyChoresTool(name, args = {}, { creds, spec }) {
	const opts = { token: creds.token, baseUrl: creds.baseUrl };

	if (name === "call_family_chores_api") {
		const path = args.path;
		const allowed = buildAllowedGetPaths(spec);
		if (!allowed.length) {
			throw new Error("API catalog unavailable; cannot validate path");
		}
		if (!isAllowedGetPath(path, allowed)) {
			throw new Error(
				`Path "${path}" is not a documented GET endpoint. Choose one from the catalog.`
			);
		}
		return familyChores.apiGet(path, opts);
	}

	if (name === "get_player_chores") {
		const chores = await familyChores.getChores(
			creds.playerId,
			{
				range: args.range,
				from: args.from,
				to: args.to,
				status: args.status,
				category: args.category,
			},
			opts
		);
		return { chores };
	}

	if (name === "get_player_coins") {
		return familyChores.getCoins(creds.playerId, opts);
	}

	throw new Error(`Unknown Family Chores tool: ${name}`);
}

module.exports = {
	FAMILY_CHORES_FUNCTION_DECLARATIONS,
	executeFamilyChoresTool,
	summarizeEndpoints,
	buildAllowedGetPaths,
	isAllowedGetPath,
};
