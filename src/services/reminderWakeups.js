/**
 * Wake the reminders job at the moment something is due — and only then.
 *
 * Time reminders and the "still want it?" check for conditional place
 * reminders need something to run at a given minute. A scheduler polling
 * every minute was rejected by the owner (2026-10-11): it costs money around
 * the clock for a handful of reminders a day. Instead each reminder books one
 * Cloud Task for its own time, and the task runs the athena-reminders Cloud
 * Run Job once (the same OAuth call Cloud Scheduler makes for the other jobs).
 * Nothing runs while nothing is due.
 *
 * Tasks are named by the minute they wake, so ten reminders at 7:00 start
 * the job once; a name that already exists is success, not an error.
 *
 * Never throws and never blocks setting a reminder: a wake-up that couldn't
 * be booked is logged, and the hourly athena-incidents run sends anything
 * overdue as a backstop (src/jobs/incidents.js), so a reminder is at worst
 * late, never lost.
 *
 * Config (env): REMINDER_QUEUE (default "athena-reminders"), REMINDER_REGION
 * (default "us-central1"), REMINDER_JOB (default "athena-reminders"),
 * REMINDER_TASK_SA (the service account the task calls the Run API as;
 * defaults to the runtime's own), GCP_PROJECT_ID.
 */
const { GoogleAuth } = require("google-auth-library");

const QUEUE = process.env.REMINDER_QUEUE || "athena-reminders";
const REGION = process.env.REMINDER_REGION || "us-central1";
const JOB = process.env.REMINDER_JOB || "athena-reminders";
/** Wake a little after the minute, so a reminder set for 7:00:00 is due when the job looks. */
const SLACK_MS = 5_000;

let auth = null;
const authOf = () =>
	(auth ||= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }));

async function projectId() {
	const fromEnv = process.env.GCP_PROJECT_ID;
	// The local .env says "athena", which resolves to nothing; ask the credentials instead.
	if (fromEnv && fromEnv !== "athena") return fromEnv;
	return authOf().getProjectId();
}

async function serviceAccount() {
	if (process.env.REMINDER_TASK_SA) return process.env.REMINDER_TASK_SA;
	const creds = await authOf().getCredentials();
	return creds.client_email;
}

/**
 * Book one run of the reminders job at `at` (a Date or ISO string). Returns
 * true when booked (or already booked for that minute), false otherwise.
 */
async function wakeAt(at) {
	const when = new Date(at);
	if (!Number.isFinite(when.getTime())) return false;
	if (process.env.NODE_ENV === "test" && !process.env.REMINDER_WAKEUPS_IN_TESTS) return false;
	try {
		const [project, email] = await Promise.all([projectId(), serviceAccount()]);
		if (!project || !email) throw new Error("no project or service account to book with");
		const fire = new Date(Math.max(when.getTime(), Date.now()) + SLACK_MS);
		const minute = Math.floor(fire.getTime() / 60_000);
		const parent = `projects/${project}/locations/${REGION}/queues/${QUEUE}`;
		const client = await authOf().getClient();
		await client.request({
			url: `https://cloudtasks.googleapis.com/v2/${parent}/tasks`,
			method: "POST",
			data: {
				task: {
					name: `${parent}/tasks/wake-${minute}`,
					scheduleTime: fire.toISOString(),
					httpRequest: {
						httpMethod: "POST",
						url: `https://run.googleapis.com/v2/projects/${project}/locations/${REGION}/jobs/${JOB}:run`,
						oauthToken: { serviceAccountEmail: email, scope: "https://www.googleapis.com/auth/cloud-platform" },
					},
				},
			},
		});
		return true;
	} catch (err) {
		// 409: a run is already booked for that minute — which is the point.
		if (err?.response?.status === 409 || /ALREADY_EXISTS/.test(String(err?.message))) return true;
		console.warn("[reminderWakeups] couldn't book a wake-up (the hourly backstop will catch it):", err.message);
		return false;
	}
}

module.exports = { wakeAt, _reset: () => (auth = null) };
