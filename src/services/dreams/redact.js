/**
 * The Dreams log as the household may see it: the shape of what she did,
 * without the values she did it with.
 *
 * athena_dream_step stores every statement verbatim — that is the audit, and
 * `npm run dreams` shows it to whoever holds the database. Anything that
 * leaves through the API or into a model prompt goes through here first:
 * string literals become '…', upserted rows become a count and column list,
 * and question/answer text is only shown to the person it was for.
 */

/** Replace quoted string literals with '…'. Keeps identifiers (backticks). */
function redactSql(sql) {
	return String(sql || "").replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"/g, "'…'");
}

function upsertShape(statement) {
	const m = /^UPSERT (\S+) ([\s\S]*)$/.exec(String(statement || ""));
	if (!m) return "UPSERT";
	let rows = [];
	try {
		rows = JSON.parse(m[2]);
	} catch {
		/* shape only */
	}
	if (!Array.isArray(rows)) rows = [];
	const cols = [...new Set(rows.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : [])))];
	return `UPSERT ${m[1]} — ${rows.length} row${rows.length === 1 ? "" : "s"}${cols.length ? ` (${cols.join(", ")})` : ""}`;
}

/**
 * One step, safe to show. `viewerOwns(profileId)` decides whether question
 * text may be shown; the log only knows the profile from the ASK line.
 */
function redactStep(step, { viewerProfileId = null } = {}) {
	const out = { ...step };
	const s = String(step.statement || "");
	switch (step.kind) {
		case "upsert":
			out.statement = upsertShape(s);
			break;
		case "question": {
			const m = /^ASK p(\d+): /.exec(s);
			out.statement = m && Number(m[1]) === Number(viewerProfileId) ? s.replace(/^ASK p\d+: /, "ASK you: ") : "ASK someone a question";
			break;
		}
		case "answer":
			out.statement = s.replace(/\):[\s\S]*$/, ")");
			break;
		case "describe":
		case "note":
			break;
		default:
			out.statement = step.statement == null ? null : redactSql(s);
	}
	if (out.error) out.error = redactSql(out.error);
	return out;
}

module.exports = { redactSql, redactStep, upsertShape };
