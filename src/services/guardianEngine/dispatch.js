/**
 * Getting a due Guardian run to the one process that can observe it.
 *
 * Only the core Cloud Run service reaches the Eufy bridge (it is on the
 * tailnet; the Cloud Run Jobs are not). So the athena-incidents job plans
 * and then asks the service to observe, and exact times (10:00 PM, a recheck
 * in fifteen minutes) are Cloud Tasks that call the service at that minute.
 * Both arrive at POST /internal/guardian/dispatch carrying a Google-signed ID
 * token; the service accepts only the service accounts it was configured to.
 *
 * Nothing here decides anything — a dispatch only says "look at what's due".
 * A dispatch that never arrives is caught by the planner: a run not observed
 * within its overdue window is reported to the adults as unverifiable.
 *
 * Env:
 *   GUARDIAN_DISPATCH_URL                 <core service URL>/internal/guardian/dispatch
 *   GUARDIAN_DISPATCH_AUDIENCE            the core service URL the ID token is minted for
 *   GUARDIAN_DISPATCH_SERVICE_ACCOUNTS    (service) comma list of callers allowed to dispatch
 *   GUARDIAN_DISPATCH_INVOKER_SA          (job) the account whose ID token the job sends
 *   GUARDIAN_TASK_SA                      the account Cloud Tasks signs as
 *
 * Both should be a dedicated dispatch account (athena-guardian-dispatch@),
 * never the runtime's own: the proxy runs as the default compute account and
 * forwards every signed-in request to core with that account's token, so
 * allowlisting it would let any signed-in person call dispatch through the
 * proxy. The job keeps its own identity and mints the dispatch account's
 * token by impersonation (it holds Token Creator on that account only).
 */
const { OAuth2Client } = require("google-auth-library");
const wakeups = require("../reminderWakeups");

const verifier = new OAuth2Client();
const configured = () => Boolean(process.env.GUARDIAN_DISPATCH_URL && process.env.GUARDIAN_DISPATCH_AUDIENCE);

/** The job's call: dispatch now. Resolves { ok, status?, skipped? }; never throws. */
async function dispatchNow({ reason = "planned" } = {}) {
	if (!configured()) return { ok: false, skipped: "not configured" };
	try {
		const audience = process.env.GUARDIAN_DISPATCH_AUDIENCE;
		const invoker = process.env.GUARDIAN_DISPATCH_INVOKER_SA;
		let res;
		if (invoker) {
			const auth = await wakeups.authOf().getClient();
			const minted = await auth.request({
				url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(invoker)}:generateIdToken`,
				method: "POST",
				data: { audience, includeEmail: true },
			});
			const response = await fetch(process.env.GUARDIAN_DISPATCH_URL, {
				method: "POST",
				headers: { Authorization: `Bearer ${minted.data.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ reason }),
				signal: AbortSignal.timeout(280_000),
			});
			res = { status: response.status, data: await response.json().catch(() => null) };
		} else {
			const client = await wakeups.authOf().getIdTokenClient(audience);
			res = await client.request({ url: process.env.GUARDIAN_DISPATCH_URL, method: "POST", data: { reason }, timeout: 280_000 });
		}
		return { ok: res.status >= 200 && res.status < 300, status: res.status, body: res.data };
	} catch (error) {
		return { ok: false, status: error?.response?.status || null, error: error?.message };
	}
}

/**
 * Book one dispatch at `at`. Named by minute, so a sweep and a recheck that
 * fall in the same minute share one call. Returns true when booked or already
 * booked; false otherwise (the job's next pass is the backstop).
 */
async function wakeAt(at) {
	const when = new Date(at);
	if (!Number.isFinite(when.getTime()) || !configured()) return false;
	if (process.env.NODE_ENV === "test" && !process.env.GUARDIAN_WAKEUPS_IN_TESTS) return false;
	try {
		const [project, email] = await Promise.all([wakeups.projectId(), process.env.GUARDIAN_TASK_SA || process.env.GUARDIAN_DISPATCH_INVOKER_SA || wakeups.serviceAccount()]);
		if (!project || !email) throw new Error("no project or service account to book with");
		const fire = new Date(Math.max(when.getTime(), Date.now()) + 5_000);
		const minute = Math.floor(fire.getTime() / 60_000);
		const parent = `projects/${project}/locations/${wakeups.REGION}/queues/${process.env.GUARDIAN_TASK_QUEUE || wakeups.QUEUE}`;
		const client = await wakeups.authOf().getClient();
		await client.request({
			url: `https://cloudtasks.googleapis.com/v2/${parent}/tasks`,
			method: "POST",
			data: {
				task: {
					name: `${parent}/tasks/guardian-${minute}`,
					scheduleTime: fire.toISOString(),
					dispatchDeadline: "300s",
					httpRequest: {
						httpMethod: "POST",
						url: process.env.GUARDIAN_DISPATCH_URL,
						headers: { "Content-Type": "application/json" },
						body: Buffer.from(JSON.stringify({ reason: "wake" })).toString("base64"),
						oidcToken: { serviceAccountEmail: email, audience: process.env.GUARDIAN_DISPATCH_AUDIENCE },
					},
				},
			},
		});
		return true;
	} catch (err) {
		if (err?.response?.status === 409 || /ALREADY_EXISTS/.test(String(err?.message))) return true;
		console.warn("[guardian] couldn't book a wake-up (the incidents job is the backstop):", err.message);
		return false;
	}
}

/** Is this request a dispatch from an allowed caller? Checks the token's audience, signature and account. */
async function verifyCaller(req, { verify = verifier } = {}) {
	const audience = process.env.GUARDIAN_DISPATCH_AUDIENCE;
	const allowed = (process.env.GUARDIAN_DISPATCH_SERVICE_ACCOUNTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
	const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.get("Authorization") || "");
	if (!audience || !allowed.length || !match) return false;
	try {
		const ticket = await verify.verifyIdToken({ idToken: match[1], audience });
		const claims = ticket.getPayload() || {};
		return claims.email_verified === true && allowed.includes(String(claims.email || "").toLowerCase());
	} catch {
		return false;
	}
}

module.exports = { dispatchNow, wakeAt, verifyCaller, configured };
