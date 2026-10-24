/**
 * The only legal moves for a run and an incident. The engine changes state
 * through transition(), never by writing a state string directly, so an
 * impossible history ("resolved" before anything was observed, an
 * acknowledgement that closes an incident) is a thrown error, not a row.
 */

const RUN = {
	scheduled: ["observing", "suppressed", "expired", "unknown", "failed"],
	// A run whose lease ran out (a restart mid-observation) goes back round.
	observing: ["evaluating", "observing", "failed", "suppressed"],
	evaluating: ["safe", "attention_required", "unknown", "failed", "observing"],
	attention_required: ["notified"],
	unknown: ["notified"],
	safe: [],
	notified: [],
	failed: ["notified"],
	expired: [],
	suppressed: [],
};
const RUN_TERMINAL = new Set(["safe", "notified", "failed", "expired", "suppressed", "attention_required", "unknown"]);

const INCIDENT = {
	open: ["notified", "acknowledged", "resolved", "dismissed", "expired"],
	notified: ["acknowledged", "resolved", "dismissed", "expired"],
	// Acknowledged is "someone has seen it", never "it is fixed".
	acknowledged: ["resolved", "dismissed", "expired"],
	resolved: [],
	dismissed: [],
	expired: [],
};
const INCIDENT_ACTIVE = ["open", "notified", "acknowledged"];

function check(table, kind, from, to) {
	if (!table[from] || !table[from].includes(to)) {
		throw Object.assign(new Error(`illegal ${kind} transition ${from} -> ${to}`), { code: "illegal_transition" });
	}
	return to;
}

const runTransition = (from, to) => check(RUN, "run", from, to);
const incidentTransition = (from, to) => check(INCIDENT, "incident", from, to);

module.exports = { RUN, INCIDENT, RUN_TERMINAL, INCIDENT_ACTIVE, runTransition, incidentTransition };
