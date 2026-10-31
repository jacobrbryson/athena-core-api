/**
 * May Athena use this capability, for this mission, toward this person, now?
 *
 * Pure and deterministic: every input is a row the caller read, nothing here
 * reads a model's output, and the answer is one of three things:
 *
 *   allow    go ahead
 *   hold     not now - keep the ask and send it when the hold lifts
 *            (master pause, quiet-until, a person's mute)
 *   refuse   never, as asked (kill switch, disabled, not in the mission's
 *            list, mode-locked outside a running mission, no agreement, or
 *            anyone who isn't a Guardian or their parent)
 *
 * Contact is default-deny (owner, 2026-10-31): Athena reaches only Guardians
 * and parents who agreed to help train her. Widening that is a deliberate
 * change here, not something a mission can ask for.
 *
 * A hold never drops anything. That is the owner's rule from 2026-09-19 ("I
 * don't want to miss anything because of a budget"): a pause or mute delays
 * an ask; it does not discard it. Nothing here counts asks or spaces them out
 * - there are no rate limits on her asks.
 *
 * `needsApproval` is set when the call itself must go through the action
 * layer's per-call approval: a capability marked parent_approval, or anything
 * that spends money.
 */

const MODES = new Set(["running", "quiet_until", "paused"]);

function decision(verdict, reason, extra = {}) {
	return { verdict, allowed: verdict === "allow", reason, ...extra };
}

/**
 * @param {object} p
 * @param {object} p.control     athena_gm_control row
 * @param {object} p.capability  athena_gm_capability row
 * @param {object} [p.mission]   athena_gm_mission row, with `capabilityIds` (array of ids)
 * @param {object} [p.recipient] athena_gm_actor row the ask goes to
 * @param {object} [p.consent]   consent.standingFor(recipient); required when there is a recipient
 * @param {object} [p.flags]     { spendsMoney, contactsOutsider }
 * @param {Date}   [p.now]
 */
function mayUse({ control, capability, mission = null, recipient = null, consent = null, flags = {}, now = new Date() }) {
	if (!capability) return decision("refuse", "unknown capability");
	const c = control || { mode: "running", kill_switch: 0 };

	if (flags.contactsOutsider || (recipient && !["parent", "kid"].includes(recipient.kind))) {
		return decision("refuse", "Athena only contacts Guardians and their parents");
	}
	// Checked before any hold: without an agreement there is nothing to hold for.
	if (recipient && !consent?.allowed) {
		return decision("refuse", `${recipient.display_name}: ${consent?.reason || "no agreement on record"}`);
	}

	// The kill switch cuts lights and cameras whatever else is true.
	if (truthy(c.kill_switch) && truthy(capability.house_control)) {
		return decision("refuse", "the kill switch is on: Athena has no control of lights or cameras");
	}
	if (!truthy(capability.enabled)) return decision("refuse", `${capability.name} is switched off`);

	if (mission) {
		const ids = new Set((mission.capabilityIds || []).map(Number));
		// Least privilege: a mission touches only what it lists.
		if (!ids.has(Number(capability.id))) {
			return decision("refuse", `${capability.name} is not one of this mission's capabilities`);
		}
		if (mission.approval_state !== "approved") return decision("refuse", "this mission's plan has not been approved");
		if (mission.status !== "running") return decision("refuse", `this mission is ${mission.status}, not running`);
	}

	// Mission mode: lights, speaking through cameras and messaging the kids'
	// devices work only while a mission that lists them is running.
	if (truthy(capability.mission_only) && !mission) {
		return decision("refuse", `${capability.name} only works while a mission is running`);
	}
	if (recipient?.kind === "kid" && !mission) {
		return decision("refuse", "Athena messages the kids only while a mission is running");
	}
	// Prep is for adults: a kid hears nothing until an adult has pressed Go.
	if (recipient?.kind === "kid" && mission.phase !== "live") {
		return decision("refuse", "Athena messages the kids only after an adult presses Go");
	}

	// Holds: delay, never drop.
	const mode = MODES.has(c.mode) ? c.mode : "running";
	if (mode === "paused") return decision("hold", "Athena is paused", { until: null });
	if (mode === "quiet_until") {
		const until = c.quiet_until ? new Date(c.quiet_until) : null;
		if (until && until > now) return decision("hold", "quiet hours are on", { until });
	}
	if (recipient && truthy(recipient.muted)) {
		const until = recipient.muted_until ? new Date(recipient.muted_until) : null;
		if (!until || until > now) return decision("hold", `${recipient.display_name} is muted`, { until });
	}

	const needsApproval = capability.permission === "parent_approval" || Boolean(flags.spendsMoney);
	return decision("allow", null, { needsApproval });
}

function truthy(v) {
	return v === 1 || v === true || v === "1";
}

/**
 * The status strip's colour: does anything need the parent?
 *   red     a step is stuck, or a step waiting on the parent is overdue
 *   yellow  a step is waiting on the parent, or a plan awaits approval
 *   green   nothing needs them
 */
function attention({ steps = [], proposedCount = 0, now = new Date() }) {
	const mine = steps.filter((s) => s.status === "waiting_parent");
	if (steps.some((s) => s.status === "stuck") || mine.some((s) => s.due_at && new Date(s.due_at) < now)) return "red";
	if (mine.length || proposedCount > 0) return "yellow";
	return "green";
}

module.exports = { mayUse, attention };
