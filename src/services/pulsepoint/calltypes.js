/**
 * What a dispatch code actually means, in words a person can use.
 *
 * PulsePoint sends a two-or-three letter code — "SF", "TC", "WSF" — and
 * nothing else. "There is an SF four blocks away" is useless; "there is a
 * structure fire four blocks away" is the whole point of this feature. So the
 * table beside this file maps every code to a description and a category.
 *
 * `calltypes.json` is lifted verbatim from PulsePoint's own web client, which
 * ships it in the clear. That matters for one field in particular:
 * `alertable` is THEIR judgement about which codes are worth interrupting a
 * person for, made by people who do this for a living. A medical emergency is
 * not alertable; a confirmed structure fire is. We do not second-guess it,
 * because inventing our own list would mean maintaining a fire-service triage
 * opinion we have no business having.
 *
 * Re-extracting it, when their client changes: the codes live in the app
 * bundle as `{id:"SF",description:"Structure Fire",category:"Fire",alertable:!0}`.
 * See `docs/capabilities/nearby-incidents.md` for the exact recipe.
 */
const TABLE = require("./calltypes.json");

/** code -> {id, description, category, alertable}. Built once. */
const BY_ID = new Map(TABLE.map((entry) => [entry.id, entry]));

/**
 * The entry for a dispatch code, or null if we have never heard of it.
 *
 * Unknown codes are expected, not exceptional: agencies add local codes, and
 * PulsePoint adds codes faster than we re-extract the table. Callers must
 * handle null rather than assume this always answers.
 */
function lookup(code) {
	if (typeof code !== "string") return null;
	return BY_ID.get(code.trim().toUpperCase()) || null;
}

/**
 * How to say the code out loud. Falls back to the code itself, because
 * "there is an SF nearby" is still better than "there is a nearby incident".
 */
function describe(code) {
	const entry = lookup(code);
	if (entry) return entry.description;
	return typeof code === "string" && code.trim()
		? code.trim().toUpperCase()
		: "Unknown incident";
}

/**
 * Is this the kind of call worth lighting up a phone for?
 *
 * An unknown code is NOT alertable. That direction of the default is
 * deliberate: a code we cannot name produces "something is happening nearby
 * and I do not know what", which is the one message guaranteed to worry
 * without informing. It still reaches the dashboard, where it costs nothing.
 */
function isAlertable(code) {
	const entry = lookup(code);
	return entry ? entry.alertable === true : false;
}

/** Every category name in the table, for grouping a list in the UI. */
function categories() {
	return [...new Set(TABLE.map((entry) => entry.category))].sort();
}

module.exports = { lookup, describe, isAlertable, categories, TABLE };
