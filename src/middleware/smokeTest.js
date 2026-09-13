const { runAsSmoke } = require("../services/llm/telemetry");

/**
 * Marks a request as a smoke test, so the model calls it makes are labelled
 * `smoke:<task>` in `llm_call_log` and kept out of the nightly review's health
 * metrics (see services/llm/telemetry.js).
 *
 * This is a LABEL, not a permission: it changes nothing about what the request
 * may do, and every call is still logged in full and still counted — the
 * nightly report prints how many smoke calls it set aside, so marking traffic
 * can never make it disappear. It sits after the access boundary, so only a
 * caller Athena already trusts with her models can label anything at all.
 */
module.exports = function smokeTest(req, res, next) {
	const header = req.headers["x-athena-smoke"];
	if (header !== "1" && header !== "true") return next();
	runAsSmoke(next);
};
