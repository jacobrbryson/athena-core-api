/**
 * Throwaway read-only diagnostic for the Google Calendar connector.
 *
 * Answers, in one run: is the credential stored and active, does the token
 * still work, and does the account actually have events — on `primary` (the
 * only calendar the connector reads) and on every other calendar it can see.
 *
 * Run from core_api/:  node diagnose-calendar.js
 * Reads only. Delete when done.
 */
require("dotenv").config();

const pool = require("./src/helpers/db");
const credentials = require("./src/services/credentials");
const oauth = require("./src/services/connectors/oauth");

const PROVIDER = "google_calendar";

function fmtWindow(days = 7) {
	const start = new Date();
	start.setHours(0, 0, 0, 0);
	const end = new Date(start);
	end.setDate(end.getDate() + days);
	return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

async function api(token, path, query = {}) {
	const url = new URL(`https://www.googleapis.com/calendar/v3${path}`);
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
	});
	const body = await res.text();
	let json = null;
	try {
		json = body ? JSON.parse(body) : null;
	} catch {
		/* non-JSON */
	}
	return { status: res.status, json, raw: body.slice(0, 400) };
}

(async () => {
	const [rows] = await pool.query(
		`SELECT id, profile_id, provider, external_account_id, display_name,
		        scopes, expires_at, status,
		        (refresh_token_enc IS NULL) AS no_refresh_token,
		        last_refreshed_at, last_used_at, created_at, updated_at
		   FROM user_credential
		  WHERE provider = ?
		  ORDER BY updated_at DESC`,
		[PROVIDER]
	);
	console.log("=== user_credential rows for google_calendar ===");
	console.log(JSON.stringify(rows, null, 2));
	if (!rows.length) {
		console.log("No credential stored. Nothing else to check.");
		return;
	}

	for (const row of rows) {
		console.log(`\n=== profile_id ${row.profile_id} (status ${row.status}) ===`);

		const token = await oauth.accessToken(row.profile_id, PROVIDER, {
			actor: "diagnostic",
		});
		if (!token) {
			console.log("accessToken() returned null — the link needs reconnecting.");
			continue;
		}
		console.log("accessToken() OK.");

		const { timeMin, timeMax } = fmtWindow(7);
		console.log(`window: ${timeMin} .. ${timeMax}`);

		const primary = await api(token, "/calendars/primary/events", {
			timeMin,
			timeMax,
			singleEvents: "true",
			orderBy: "startTime",
			maxResults: 25,
		});
		console.log(`primary -> HTTP ${primary.status}`);
		if (primary.json?.items) {
			console.log(`primary events: ${primary.json.items.length}`);
			for (const e of primary.json.items) {
				console.log(`  - ${e.start?.dateTime || e.start?.date} ${e.summary}`);
			}
		} else {
			console.log(primary.raw);
		}

		// The connector only ever reads `primary`. If the events live on another
		// calendar, this is where that shows up.
		const list = await api(token, "/users/me/calendarList", { maxResults: 50 });
		console.log(`\ncalendarList -> HTTP ${list.status}`);
		for (const cal of list.json?.items || []) {
			const events = await api(
				token,
				`/calendars/${encodeURIComponent(cal.id)}/events`,
				{ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: 10 }
			);
			const n = events.json?.items?.length ?? `HTTP ${events.status}`;
			console.log(
				`  ${cal.primary ? "*" : " "} ${cal.id} (${cal.summary})` +
					` [${cal.timeZone || "no zone"}] -> ${n} events`
			);
		}
	}
})()
	.catch((err) => {
		console.error("FAILED:", err.message);
		process.exitCode = 1;
	})
	.finally(() => pool.end?.());
