/**
 * Delegated autonomy for the Guardian Engine: may the engine do this by
 * itself, and if so, does a person hear about it?
 *
 *   Level 0  observe only
 *   Level 1  low-risk internal action, silently
 *   Level 2  preauthorized action, then notify
 *   Level 3  ask a person first (the action layer's proposal/approval card)
 *   Level 4  prohibited without specialised authorization
 *
 * Deterministic and closed: every action is a constant in ACTIONS below. A
 * model's output never names an action — the engine calls authorize() with
 * ids written in code — so no reply, image caption or prompt injection can
 * reach a level it was not given here.
 *
 * Each action is scored on the seven dimensions the owner listed, then the
 * HARD RULES run and can only raise the level. A configuration may make an
 * action stricter (notify → observe only); nothing may make one looser. The
 * engine executes level 2 and below and refuses everything else: there is no
 * code path from here to a physical device, a purchase or a permission change.
 */

const LEVEL = { OBSERVE: 0, SILENT: 1, ACT_AND_NOTIFY: 2, ASK_FIRST: 3, PROHIBITED: 4 };
const MAX_EXECUTABLE = LEVEL.ACT_AND_NOTIFY;

/**
 * Dimensions, each 0 (none) to 3 (high):
 *   cost         money spent
 *   physical     risk to a body or the property if it goes wrong
 *   privacy      how sensitive what it touches is
 *   irreversible 0 = undo is free, 3 = cannot be undone
 *   social       consequence for relationships / outsiders
 *   scope        how many household members it affects
 * Flags carry the facts the hard rules read.
 */
const ACTIONS = {
	"camera.status": { label: "Read camera status", cost: 0, physical: 0, privacy: 1, irreversible: 0, social: 0, scope: 1, base: LEVEL.SILENT },
	"camera.fresh_snapshot": { label: "Request a fresh camera image", cost: 0, physical: 0, privacy: 2, irreversible: 0, social: 0, scope: 1, base: LEVEL.SILENT },
	"weather.read": { label: "Read forecasts and weather alerts", cost: 0, physical: 0, privacy: 0, irreversible: 0, social: 0, scope: 0, base: LEVEL.SILENT },
	"analysis.vision": { label: "Analyse a household camera image", cost: 0, physical: 0, privacy: 2, irreversible: 0, social: 0, scope: 1, base: LEVEL.SILENT },
	"incident.write": { label: "Create or update a Guardian incident", cost: 0, physical: 0, privacy: 1, irreversible: 0, social: 0, scope: 1, base: LEVEL.SILENT },
	"observation.retry": { label: "Retry a failed observation", cost: 0, physical: 0, privacy: 2, irreversible: 0, social: 0, scope: 1, base: LEVEL.SILENT },
	"incident.verify": { label: "Recheck whether an incident is resolved", cost: 0, physical: 0, privacy: 2, irreversible: 0, social: 0, scope: 1, base: LEVEL.SILENT },
	"notify.household": { label: "Send a safety notification to approved household adults", cost: 0, physical: 0, privacy: 1, irreversible: 1, social: 1, scope: 2, base: LEVEL.ACT_AND_NOTIFY, flags: { notifies: true } },
	// Not executable by the engine. Listed so a request for them is refused
	// with a reason and audited, rather than being an unknown id.
	"device.garage_close": { label: "Close a garage door", cost: 0, physical: 3, privacy: 0, irreversible: 1, social: 0, scope: 3, base: LEVEL.ASK_FIRST, flags: { physical: true } },
	"device.lock": { label: "Lock or unlock a door", cost: 0, physical: 3, privacy: 0, irreversible: 1, social: 1, scope: 3, base: LEVEL.ASK_FIRST, flags: { physical: true } },
	"device.hvac": { label: "Change heating or cooling", cost: 1, physical: 2, privacy: 0, irreversible: 1, social: 0, scope: 3, base: LEVEL.ASK_FIRST, flags: { physical: true } },
	"purchase.any": { label: "Buy something", cost: 3, physical: 0, privacy: 1, irreversible: 2, social: 1, scope: 1, base: LEVEL.ASK_FIRST, flags: { purchase: true } },
	"notify.external": { label: "Message someone outside the approved recipients", cost: 1, physical: 0, privacy: 3, irreversible: 3, social: 3, scope: 3, base: LEVEL.ASK_FIRST, flags: { external: true } },
	"media.share_external": { label: "Send camera imagery outside the household", cost: 0, physical: 0, privacy: 3, irreversible: 3, social: 3, scope: 3, base: LEVEL.PROHIBITED, flags: { imageryLeaves: true } },
	"security.change_permissions": { label: "Change security permissions", cost: 0, physical: 2, privacy: 3, irreversible: 2, social: 2, scope: 3, base: LEVEL.PROHIBITED, flags: { permissions: true } },
};

/** The score's own read, before hard rules: the riskiest dimension decides, low confidence adds one. */
function scoredLevel(action, { confidence = null } = {}) {
	const worst = Math.max(action.cost, action.physical, action.privacy, action.irreversible, action.social);
	let level = worst >= 3 ? LEVEL.ASK_FIRST : LEVEL.SILENT;
	if (action.flags?.notifies) level = Math.max(level, LEVEL.ACT_AND_NOTIFY);
	// Acting on a doubtful observation is riskier than acting on a sure one —
	// but only for things that change the world. Reading is fine either way.
	if (Number.isFinite(confidence) && confidence < 0.5 && action.physical > 0) level += 1;
	return Math.min(level, LEVEL.PROHIBITED);
}

/** Hard safety and privacy rules. They only ever raise. */
function hardFloor(action, ctx) {
	const f = action.flags || {};
	let floor = action.base;
	const why = [];
	if (f.physical) (floor = Math.max(floor, LEVEL.ASK_FIRST)), why.push("physical security actions need a person's approval");
	if (f.purchase) (floor = Math.max(floor, LEVEL.ASK_FIRST)), why.push("purchases need a person's approval");
	if (f.external) (floor = Math.max(floor, LEVEL.ASK_FIRST)), why.push("messages outside the approved household recipients need approval");
	if (f.permissions) (floor = Math.max(floor, LEVEL.PROHIBITED)), why.push("security permissions are changed only by the owner");
	if (f.imageryLeaves) (floor = Math.max(floor, LEVEL.PROHIBITED)), why.push("camera imagery never leaves the household");
	// A notification whose recipient is not an approved household adult is an
	// external message, whatever action id it arrived under.
	if (f.notifies && ctx.recipientApproved === false) (floor = Math.max(floor, LEVEL.ASK_FIRST)), why.push("that recipient is not an approved household adult");
	return { floor, why };
}

/**
 * Decide one action. Returns { allowed, level, actionId, reasons, notify }.
 * `restrict` is the protocol's own configuration: { [actionId]: maxLevel }
 * where a lower number means "do less" — notify.household: 0 turns alerts
 * into observe-only. It can only lower what is allowed.
 */
function authorize(actionId, ctx = {}) {
	const action = ACTIONS[actionId];
	if (!action) return { allowed: false, level: LEVEL.PROHIBITED, actionId, reasons: ["unknown action"], notify: false };
	const scored = scoredLevel(action, ctx);
	const { floor, why } = hardFloor(action, ctx);
	const level = Math.max(scored, floor);
	if (level > MAX_EXECUTABLE) {
		return { allowed: false, level, actionId, reasons: why.length ? why : ["above the engine's standing authority"], notify: false };
	}
	const ceiling = ctx.restrict && Number.isInteger(ctx.restrict[actionId]) ? ctx.restrict[actionId] : null;
	if (ceiling !== null && ceiling < level) {
		// Configured stricter. Observe-only for a notification means "record, don't send".
		return { allowed: false, level, actionId, reasons: [`restricted to level ${ceiling} by this protocol's settings`], notify: false, restricted: true };
	}
	return { allowed: true, level, actionId, reasons: [], notify: level === LEVEL.ACT_AND_NOTIFY };
}

/** Clean a configured restriction map: known actions only, integer levels 0-4, never above the action's own level. */
function normalizeRestrictions(input) {
	const out = {};
	if (!input || typeof input !== "object") return out;
	for (const [id, value] of Object.entries(input)) {
		const n = Number(value);
		if (!ACTIONS[id] || !Number.isInteger(n) || n < 0 || n > LEVEL.PROHIBITED) continue;
		out[id] = n;
	}
	return out;
}

/** The standing permissions, for the dashboard: what she may do alone, and what she may not. */
function describe(restrict = {}) {
	return Object.entries(ACTIONS).map(([id, a]) => {
		const decision = authorize(id, { restrict });
		return { id, label: a.label, level: decision.level, allowed: decision.allowed, reasons: decision.reasons };
	});
}

module.exports = { LEVEL, ACTIONS, MAX_EXECUTABLE, authorize, normalizeRestrictions, describe, scoredLevel };
