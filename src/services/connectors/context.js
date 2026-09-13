const googleCalendar = require("./googleCalendar");
const strava = require("./strava");
const whoop = require("./whoop");
const { isNotConnected } = require("./http");
const credentials = require("../credentials");

/**
 * Turns linked integrations into grounding for a conversation turn.
 *
 * Two ways in, mirroring the Family Chores split:
 *   buildContext()  — a plain-text snapshot appended to the system prompt.
 *                     Cheap, deterministic, one call per relevant provider.
 *   TOOLS / executeTool() — typed function declarations, for the tool-calling
 *                     path where the model picks the query itself.
 *
 * Both are keyword-gated first, so a message about dinner never costs a
 * Strava round trip. A provider that is not linked, or whose API fails, is
 * skipped silently: an integration must never be able to sink a reply.
 */

const CONNECTORS = [googleCalendar, strava, whoop];

/** Connectors whose keyword gate the message trips. */
function relevantConnectors(message) {
	return CONNECTORS.filter((c) => c.matches(message));
}

/** Does this message plausibly need ANY connector? The cheap pre-check. */
function messageNeedsConnectors(message) {
	return relevantConnectors(message).length > 0;
}

/** Providers this profile has an active link for. */
async function linkedProviders(profileId) {
	const links = await credentials.list(profileId);
	return new Set(
		links.filter((l) => l.status === "active").map((l) => l.provider)
	);
}

/**
 * Plain-text grounding for every linked provider the message is about.
 * Returns null when there is nothing to add.
 *
 * Never throws. Each provider is independent, so a Whoop outage still leaves
 * the calendar block intact.
 */
async function buildContext(profileId, { message, days } = {}) {
	if (!profileId) return null;
	const relevant = relevantConnectors(message);
	if (!relevant.length) return null;

	let linked;
	try {
		linked = await linkedProviders(profileId);
	} catch (err) {
		console.warn("[connectors] could not list links:", err.message);
		return null;
	}

	const wanted = relevant.filter((c) => linked.has(c.PROVIDER));
	if (!wanted.length) return null;

	const blocks = await Promise.all(
		wanted.map((c) =>
			c
				.buildContext(profileId, days ? { days } : {})
				.catch((err) => {
					if (!isNotConnected(err)) {
						console.warn(`[connectors] ${c.PROVIDER} context failed:`, err.message);
					}
					return null;
				})
		)
	);

	const text = blocks.filter(Boolean).join("\n\n");
	return text || null;
}

// ---------------------------------------------------------------------------
// Tool-calling surface
// ---------------------------------------------------------------------------

/** name -> the connector that owns it, so dispatch needs no switch. */
const TOOL_OWNERS = new Map();
for (const connector of CONNECTORS) {
	for (const declaration of connector.FUNCTION_DECLARATIONS) {
		TOOL_OWNERS.set(declaration.name, connector);
	}
}

/**
 * Function declarations for the providers this profile actually has linked
 * and the message is about. Offering a tool for an unlinked provider only
 * teaches the model to call something that will fail.
 */
async function toolsFor(profileId, message) {
	const relevant = relevantConnectors(message);
	if (!relevant.length) return [];
	const linked = await linkedProviders(profileId).catch(() => new Set());
	return relevant
		.filter((c) => linked.has(c.PROVIDER))
		.flatMap((c) => c.FUNCTION_DECLARATIONS);
}

/** Dispatch one tool call to whichever connector declared it. */
async function executeTool(name, args = {}, { profileId }) {
	const connector = TOOL_OWNERS.get(name);
	if (!connector) throw new Error(`Unknown connector tool: ${name}`);
	return connector.executeTool(name, args, { profileId });
}

module.exports = {
	CONNECTORS,
	messageNeedsConnectors,
	relevantConnectors,
	linkedProviders,
	buildContext,
	toolsFor,
	executeTool,
	TOOL_OWNERS,
};
