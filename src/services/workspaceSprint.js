/**
 * The sprint card on a workspace's dashboard (and its summary on the main
 * Dashboard): every developer's story points in the open sprint — done, in
 * progress, not started — against the team's 64-point target, and their pull
 * requests reviewed vs created since the sprint began.
 *
 * Read-only, and only with the Jira and GitHub keys linked to THIS workspace
 * (the same `credentialFor` the rest of the workspace dashboard uses). Each
 * half fails on its own: GitHub being down leaves the story points standing.
 *
 * Who's in danger is decided in code here (`statusOf`), never by a model.
 * See docs/capabilities/sprint-progress.md.
 */
const crypto = require("crypto");
const workplaces = require("./workplaces");
const { credentialFor } = require("./workspaceDashboard");

/** Story points every developer must have done by the end of a sprint (owner, 2026-11-13). */
const TARGET_SP = 64;
const TIMEOUT_MS = 12000;
const CACHE_MS = 5 * 60 * 1000;
const NAMES_MS = 24 * 60 * 60 * 1000;
const GITHUB = "https://api.github.com";
const JIRA_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.atlassian\.net$/i;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const FIELD_ID = /^[a-z0-9_]+$/i;
const DAY = 86400000;
/** The only Jira team the owner cares about (2026-11-13): "I only care about red team members". */
const TEAM = /\bred\b/i;
const TEAM_LABEL = /^red[-_ ]?team$/i;

const cache = new Map(); // `${profileId}:${workspaceUuid}` → { at, value }
const fieldCache = new Map(); // jira host → { at, value }
const nameCache = new Map(); // `${org}:${key fingerprint}` → { at, value: [{ login, name }] }

/** A short one-way fingerprint of a key, so caches follow the key in use (a replaced key starts fresh). Memory only. */
const fingerprint = (c) => (c?.accessToken ? crypto.createHash("sha256").update(String(c.accessToken)).digest("hex").slice(0, 12) : "none");

const notFound = () => Object.assign(new Error("That workspace isn't on your list."), { status: 404 });
const round1 = (n) => Math.round(n * 10) / 10;

async function getJson(url, headers) {
	const res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { providerStatus: res.status });
	return res.json();
}
const errorOf = (err) => (err.providerStatus === 401 || err.providerStatus === 403 ? "rejected" : "unavailable");

/** Mon–Fri days in [from, to). */
function workdays(from, to) {
	let n = 0;
	for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t < to.getTime(); t += DAY) {
		const d = new Date(t).getUTCDay();
		if (d !== 0 && d !== 6) n += 1;
	}
	return n;
}

/** How far through the sprint we are, by working days: 0 at its start, 1 at its end. */
function elapsedFraction(start, end, now) {
	const s = new Date(start), e = new Date(end);
	if (!(e > s)) return 0;
	if (now <= s) return 0;
	if (now >= e) return 1;
	const total = workdays(s, e);
	return total ? Math.min(1, workdays(s, now) / total) : (now - s) / (e - s);
}

/**
 * Where one developer stands against the target.
 *   complete — done ≥ 64.
 *   behind   — what's left (counting in-progress work as half finished) is more
 *              than a developer can do in the time left at the 64-a-sprint rate,
 *              or there's less work in the sprint than 64 with half of it gone.
 *   at_risk  — within 20% of that line, or the sprint holds fewer than 64 points.
 *   on_track — otherwise.
 */
function statusOf({ done, inProgress, notStarted }, elapsed, target = TARGET_SP) {
	if (done >= target) return "complete";
	const planned = done + inProgress + notStarted;
	const left = target - (done + inProgress / 2);
	const capacity = target * (1 - elapsed);
	if (left > capacity || (planned < target && elapsed >= 0.5)) return "behind";
	if (left > capacity * 0.8 || planned < target) return "at_risk";
	return "on_track";
}

const letters = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");

/** The GitHub login most likely to be this Jira person, or null. Name match first, then common login shapes. */
function matchLogin(displayName, members) {
	const parts = String(displayName || "").trim().split(/\s+/).map(letters).filter(Boolean);
	if (!parts.length) return null;
	const first = parts[0], last = parts[parts.length - 1], full = parts.join("");
	const byName = members.find((m) => m.name && letters(m.name) === full);
	if (byName) return byName.login;
	const byFirstLast = parts.length > 1 && members.find((m) => {
		const n = String(m.name || "").trim().split(/\s+/).map(letters).filter(Boolean);
		return n.length > 1 && n[0] === first && n[n.length - 1] === last;
	});
	if (byFirstLast) return byFirstLast.login;
	const shapes = parts.length > 1 ? [full, first[0] + last, first + last[0], last + first, first + "_" + last] : [full];
	const byLogin = members.find((m) => shapes.includes(letters(m.login)));
	if (byLogin) return byLogin.login;
	if (parts.length < 2) return null;
	const prefixed = members.filter((m) => [full, first[0] + last].some((s) => s.length >= 5 && letters(m.login).startsWith(s)));
	return prefixed.length === 1 ? prefixed[0].login : null;
}

// --- Jira -------------------------------------------------------------------

async function jiraFields(host, headers) {
	const hit = fieldCache.get(host);
	if (hit && Date.now() - hit.at < NAMES_MS) return hit.value;
	const fields = await getJson(`https://${host}/rest/api/3/field`, headers);
	const list = Array.isArray(fields) ? fields : [];
	const sprint = list.find((f) => f?.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint")?.id || null;
	// Company-managed projects use "Story Points", team-managed "Story point estimate"; read both.
	const points = list
		.filter((f) => f?.schema?.custom === "com.pyxis.greenhopper.jira:jsw-story-points" || /^story ?points?( estimate)?$|^story point estimate$/i.test(f?.name || ""))
		.map((f) => f.id)
		.filter((id) => FIELD_ID.test(id || ""));
	// Atlassian Teams ("Team"), the older Advanced Roadmaps team, or a plain field named Team.
	const team = list
		.filter((f) => /atlassian-team|teams-plugin|\bteam\b/i.test(f?.schema?.custom || "") || /^team$/i.test(f?.name || ""))
		.map((f) => f.id)
		.filter((id) => FIELD_ID.test(id || ""));
	const value = { sprint: FIELD_ID.test(sprint || "") ? sprint : null, points: [...new Set(points)], team: [...new Set(team)] };
	fieldCache.set(host, { at: Date.now(), value });
	return value;
}

const pointsOf = (issue, ids) => {
	for (const id of ids) {
		const v = Number(issue.fields?.[id]);
		if (Number.isFinite(v) && v > 0) return v;
	}
	return 0;
};

/** True when an issue is the Red team's: its Team field names Red, or it carries a red-team label. */
function isRedTeam(issue, teamFields) {
	for (const id of teamFields) {
		const v = issue.fields?.[id];
		for (const t of Array.isArray(v) ? v : [v]) {
			const name = typeof t === "string" ? t : t?.name || t?.title || t?.value || "";
			if (TEAM.test(name)) return true;
		}
	}
	return (issue.fields?.labels || []).some((l) => TEAM_LABEL.test(String(l)));
}

/** The open sprint this person is in (or the busiest one), with each assignee's points by status. */
async function jiraSprint(c) {
	if (!c) return { error: "not_connected" };
	const host = String(c.externalAccountId || "").toLowerCase();
	if (c.kind !== "api_key" || !JIRA_HOST.test(host) || !c.displayName) return { error: "unsupported" };
	const headers = { Authorization: `Basic ${Buffer.from(`${c.displayName}:${c.accessToken}`).toString("base64")}`, Accept: "application/json" };
	try {
		const [fields, me] = await Promise.all([jiraFields(host, headers), getJson(`https://${host}/rest/api/3/myself`, headers)]);
		if (!fields.sprint) return { error: "no_sprint_field" };
		const wanted = ["summary", "status", "assignee", "labels", fields.sprint, ...fields.points, ...(fields.team || [])].join(",");
		const issues = [];
		let token;
		for (let page = 0; page < 10; page += 1) {
			const params = { jql: "sprint in openSprints() AND issuetype not in subTaskIssueTypes()", fields: wanted, maxResults: "100" };
			if (token) params.nextPageToken = token;
			const res = await getJson(`https://${host}/rest/api/3/search/jql?${new URLSearchParams(params)}`, headers);
			issues.push(...(res.issues || []));
			token = res.nextPageToken;
			if (!token || res.isLast) break;
		}
		const sprints = new Map(); // id → { sprint, issues, mine }
		for (const issue of issues) {
			const list = Array.isArray(issue.fields?.[fields.sprint]) ? issue.fields[fields.sprint] : [];
			const active = list.filter((s) => s && s.state === "active");
			for (const s of active) {
				const entry = sprints.get(s.id) || { sprint: s, issues: [], mine: 0 };
				entry.issues.push(issue);
				if (issue.fields?.assignee?.accountId === me.accountId) entry.mine += 1;
				sprints.set(s.id, entry);
			}
		}
		// The Red team's sprint first (by its issues or its name), then the one you're in, then the busiest.
		const red = (e) => e.issues.filter((i) => isRedTeam(i, fields.team || [])).length + (TEAM.test(e.sprint.name || "") ? 1000 : 0);
		const chosen = [...sprints.values()].sort((a, b) => red(b) - red(a) || b.mine - a.mine || b.issues.length - a.issues.length)[0];
		if (!chosen) return { error: "no_open_sprint" };
		// Red team members are the assignees of any Red-team issue in the sprint; all their sprint issues then count.
		// If Jira marks no issue as Red's but the sprint itself is the Red team's, everyone in it is.
		const members = new Set(chosen.issues.filter((i) => isRedTeam(i, fields.team || [])).map((i) => i.fields?.assignee?.accountId).filter(Boolean));
		const teamFound = members.size > 0 || TEAM.test(chosen.sprint.name || "");

		const people = new Map();
		let unassigned = 0;
		for (const issue of chosen.issues) {
			const a = issue.fields?.assignee;
			const sp = pointsOf(issue, fields.points);
			if (!a?.accountId) { if (!teamFound || members.size === 0 || isRedTeam(issue, fields.team || [])) unassigned += sp; continue; }
			if (teamFound && members.size > 0 && !members.has(a.accountId) && a.accountId !== me.accountId) continue;
			const p = people.get(a.accountId) || {
				id: a.accountId, name: a.displayName || "Someone", avatar: a.avatarUrls?.["48x48"] || null,
				me: a.accountId === me.accountId, issues: 0, done: 0, inProgress: 0, notStarted: 0,
			};
			p.issues += 1;
			const cat = issue.fields?.status?.statusCategory?.key;
			if (cat === "done") p.done += sp; else if (cat === "indeterminate") p.inProgress += sp; else p.notStarted += sp;
			people.set(a.accountId, p);
		}
		const s = chosen.sprint;
		return {
			error: null,
			sprint: { id: s.id, name: s.name || "Sprint", start: s.startDate || null, end: s.endDate || null, goal: s.goal || null },
			people: [...people.values()],
			teamFilter: teamFound ? "Red" : null,
			unassigned: round1(unassigned),
			otherSprints: [...sprints.values()].filter((e) => e !== chosen).map((e) => e.sprint.name).slice(0, 5),
			me: { id: me.accountId, name: me.displayName || null },
		};
	} catch (err) {
		console.warn("[workspaceSprint] jira unavailable:", err.message);
		return { error: errorOf(err) };
	}
}

// --- GitHub -----------------------------------------------------------------

async function orgMembers(org, headers, fp) {
	const hit = nameCache.get(`${org}:${fp}`);
	if (hit && Date.now() - hit.at < NAMES_MS) return hit.value;
	const list = await getJson(`${GITHUB}/orgs/${org}/members?per_page=100`, headers);
	const logins = (Array.isArray(list) ? list : []).map((m) => m?.login).filter((l) => LOGIN.test(l || "")).slice(0, 100);
	const value = await mapLimit(logins, 6, async (login) => {
		const u = await getJson(`${GITHUB}/users/${login}`, headers).catch(() => null);
		return { login, name: u?.name || null };
	});
	// An empty list is what a key without the Members permission gets; never keep that.
	if (value.length) nameCache.set(`${org}:${fp}`, { at: Date.now(), value });
	return value;
}

/**
 * The organizations the key works in. A fine-grained key's /user/orgs is empty even when it
 * can read an organization's repositories, so the owners of those repositories count too.
 */
async function orgsOf(headers) {
	const listed = await getJson(`${GITHUB}/user/orgs?per_page=100`, headers).catch(() => []);
	const orgs = new Set((Array.isArray(listed) ? listed : []).map((o) => o?.login));
	const repos = await getJson(`${GITHUB}/user/repos?per_page=100&affiliation=organization_member,collaborator`, headers).catch(() => []);
	for (const r of Array.isArray(repos) ? repos : []) if (r?.owner?.type === "Organization") orgs.add(r.owner.login);
	return [...orgs].filter((l) => LOGIN.test(l || ""));
}

/** Logins (with profile names) of whoever opened pull requests in these orgs in the last 90 days. */
async function recentAuthors(search, scope, headers) {
	const since = new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10);
	const res = await search(`is:pr created:>=${since} ${scope}`, 100);
	const logins = [...new Set((res.items || []).map((i) => i.user?.login).filter((l) => LOGIN.test(l || "")))].slice(0, 60);
	return mapLimit(logins, 6, async (login) => {
		const u = await getJson(`${GITHUB}/users/${login}`, headers).catch(() => null);
		return { login, name: u?.name || null };
	});
}

async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	}));
	return out;
}

/** Each person's PRs created and PRs reviewed (not their own) in the key's orgs since `since`. */
async function githubCounts(c, people, since) {
	if (!c) return { error: "not_connected", byId: new Map() };
	const headers = { Authorization: `Bearer ${c.accessToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
	try {
		const user = await getJson(`${GITHUB}/user`, headers);
		if (!LOGIN.test(user.login || "")) throw new Error("bad login");
		const orgs = await orgsOf(headers);
		const scope = orgs.length ? orgs.map((o) => `org:${o}`).join(" ") : "";
		const day = /^\d{4}-\d{2}-\d{2}/.test(since || "") ? since.slice(0, 10) : new Date(Date.now() - 14 * DAY).toISOString().slice(0, 10);
		const search = (q, perPage) => getJson(`${GITHUB}/search/issues?${new URLSearchParams({ q, per_page: String(perPage) })}`, headers);
		const count = (q) => search(q, 1).then((r) => Number(r.total_count) || 0);
		let members = (await Promise.all(orgs.map((o) => orgMembers(o, headers, fingerprint(c)).catch(() => [])))).flat();
		// A fine-grained key without the organization's Members permission lists nobody;
		// then the people who opened pull requests lately are who there is to match.
		if (!members.length && scope) members = await recentAuthors(search, scope, headers).catch(() => []);
		const byId = new Map();
		// Search allows 30 a minute; two per person, a few at a time.
		await mapLimit(people, 3, async (p) => {
			const login = p.me ? user.login : matchLogin(p.name, members);
			if (!login) { byId.set(p.id, { login: null, created: null, reviewed: null }); return; }
			const [created, reviewed] = await Promise.all([
				count(`is:pr author:${login} created:>=${day} ${scope}`.trim()),
				count(`is:pr reviewed-by:${login} -author:${login} updated:>=${day} ${scope}`.trim()),
			]).catch(() => [null, null]);
			byId.set(p.id, { login, created, reviewed });
		});
		const matched = [...byId.values()].filter((v) => v.login && v.login !== user.login).length;
		// Nothing to see is usually the key, not the team: say so instead of showing zeros as fact.
		const note = !orgs.length ? "no_org" : !members.length || (people.length > 1 && !matched) ? "no_team" : null;
		return { error: null, byId, note };
	} catch (err) {
		console.warn("[workspaceSprint] github unavailable:", err.message);
		return { error: errorOf(err), byId: new Map() };
	}
}

// --- Put together -----------------------------------------------------------

const STATUS_RANK = { behind: 0, at_risk: 1, on_track: 2, complete: 3 };

function summarize(jira, github, now = new Date()) {
	const elapsed = jira.sprint.start && jira.sprint.end ? elapsedFraction(jira.sprint.start, jira.sprint.end, now) : 0;
	const daysLeft = jira.sprint.end ? workdays(now, new Date(jira.sprint.end)) : null;
	const people = jira.people.map((p) => {
		const gh = github.byId.get(p.id) || { login: null, created: null, reviewed: null };
		const sp = { done: round1(p.done), inProgress: round1(p.inProgress), notStarted: round1(p.notStarted) };
		return { ...p, ...sp, github: gh, status: statusOf(sp, elapsed) };
	}).sort((a, b) => Number(b.me) - Number(a.me) || STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.done - b.done);
	const team = people.filter((p) => !p.me);
	const avg = (k) => (team.length ? round1(team.reduce((s, p) => s + p[k], 0) / team.length) : 0);
	const sum = (k) => team.reduce((s, p) => s + (p.github[k] || 0), 0);
	const known = team.filter((p) => p.github.created !== null);
	const average = { done: avg("done"), inProgress: avg("inProgress"), notStarted: avg("notStarted") };
	return {
		target: TARGET_SP,
		sprint: { ...jira.sprint, elapsed: round1(elapsed * 100) / 100, daysLeft, expected: round1(TARGET_SP * elapsed) },
		me: people.find((p) => p.me) || null,
		team: {
			size: team.length,
			// The team's chip is its worst member's, not the average's: one person at 64 can lift an
			// average over three who are behind, and who's in danger is the question this answers.
			average: { ...average, status: team.length ? team.reduce((w, p) => (STATUS_RANK[p.status] < STATUS_RANK[w] ? p.status : w), "complete") : null,
				created: known.length ? round1(sum("created") / known.length) : null, reviewed: known.length ? round1(sum("reviewed") / known.length) : null },
			atRisk: team.filter((p) => p.status === "behind" || p.status === "at_risk").map((p) => ({ name: p.name, status: p.status })),
		},
		people,
		unassigned: jira.unassigned,
		otherSprints: jira.otherSprints,
		teamFilter: jira.teamFilter,
		github: { error: github.error, note: github.note || null },
	};
}

async function read(profileId, workplaceUuid) {
	const list = await workplaces.list(profileId);
	const workspace = workplaceUuid === "primary" ? list.find((w) => w.primary) : list.find((w) => w.uuid === workplaceUuid);
	if (!workspace) throw notFound();
	// Each key is read once per load and handed down; the cache is keyed to both keys' fingerprints,
	// so saving a new GitHub or Jira key is never answered from what the old one saw.
	const [jiraKey, githubKey] = await Promise.all([credentialFor(profileId, workspace, "jira"), credentialFor(profileId, workspace, "github")]);
	const key = `${profileId}:${workspace.uuid}:${fingerprint(jiraKey)}:${fingerprint(githubKey)}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
	const jira = await jiraSprint(jiraKey);
	let value;
	let github = null;
	if (jira.error) value = { workplace: { uuid: workspace.uuid, name: workspace.name }, error: jira.error };
	else {
		github = await githubCounts(githubKey, jira.people, jira.sprint.start);
		value = { workplace: { uuid: workspace.uuid, name: workspace.name }, error: null, ...summarize(jira, github) };
	}
	// Failures and GitHub gaps aren't cached, so a fixed key shows on the next load.
	if (!value.error && !github?.error && !github?.note) cache.set(key, { at: Date.now(), value });
	return value;
}

module.exports = { read, statusOf, matchLogin, elapsedFraction, summarize, TARGET_SP };
