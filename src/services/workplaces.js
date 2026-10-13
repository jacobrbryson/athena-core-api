/**
 * Where the person works, and what they do there.
 *
 *   workplaces.list(profileId)              every workplace, primary first, with its links
 *   workplaces.overview(profileId)          that, plus the connections not yet linked
 *   workplaces.save / remove                what the person typed
 *   workplaces.link / unlink                a connection or an email address it owns
 *   workplaces.promptBlock(profileId)       the list, for Athena's chat prompt
 *
 * One person can have several: a primary job and a company they co-own. The
 * list is only what they typed — nothing is inferred from email or Jira — and
 * at most one is primary. The first one added is primary until they say
 * otherwise, and removing the primary promotes nothing: "no primary" is a true
 * answer, a guessed one is not.
 *
 * A workplace owns what the person links to it, exclusively: a connection
 * (the Jira site at vivacitytech.atlassian.net is Vivacity's) or an email
 * address. Linking reads user_credential's metadata — provider, account,
 * status — and never a token column; it says what a connection is for and
 * changes nothing about how a token is used. Choosing a workplace's tokens
 * for a read is a later step; see docs/capabilities/workplaces.md.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../helpers/db");

const MAX_WORKPLACES = 20;
const MAX_LINKS = 20;

/** "https://www.Vivacitytech.com/x" → "vivacitytech.com"; null if it isn't a domain. */
function hostOf(input) {
	const raw = String(input || "").trim().toLowerCase();
	const host = raw.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
	return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}

/** "Ross@Orcwood.com " → "ross@orcwood.com"; null if it isn't an address. */
function emailOf(input) {
	const email = String(input || "").trim().toLowerCase();
	return email.length <= 190 && /^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email) ? email : null;
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = () => Object.assign(new Error("That workplace isn't on your list."), { status: 404 });
const trim = (value, max) =>
	typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

const COLUMNS = `id, uuid, name, role, domain, is_primary, notes, updated_at`;

function toWorkplace(row) {
	return {
		uuid: row.uuid,
		name: row.name,
		role: row.role || null,
		domain: row.domain || null,
		primary: Boolean(row.is_primary),
		notes: row.notes || null,
	};
}

/** Connections that can belong to a workplace, and what to call them. Health and the like never do. */
const LINKABLE = {
	jira: "Jira Cloud",
	slack: "Slack",
	gmail: "Gmail",
	google_calendar: "Google Calendar",
	google_contacts: "Google Contacts",
	websites: "Google Websites",
	github: "GitHub",
	openai: "OpenAI",
	anthropic: "Claude",
};

/** How a connection names its account: site host and sign-in email, never a bare numeric id. */
function accountOf(row) {
	const parts = [row.external_account_id, row.display_name]
		.filter((v) => v && !/^\d+$/.test(v) && v !== LINKABLE[row.provider]);
	return [...new Set(parts)].join(" · ") || null;
}

/** The person's linkable connections, by uuid. Metadata only — never a token column. */
async function connections(profileId) {
	const [rows] = await pool.query(
		`SELECT uuid, provider, external_account_id, display_name, status FROM user_credential
		  WHERE profile_id = ? AND status <> 'revoked' AND provider IN (?)`,
		[profileId, Object.keys(LINKABLE)]
	);
	return new Map(rows.map((r) => [r.uuid, {
		credentialUuid: r.uuid,
		provider: r.provider,
		label: LINKABLE[r.provider],
		account: accountOf(r),
		status: r.status,
	}]));
}

async function load(profileId) {
	const [[rows], [linkRows], conns] = await Promise.all([
		pool.query(
			`SELECT ${COLUMNS} FROM athena_workplace WHERE profile_id = ?
			  ORDER BY is_primary DESC, name LIMIT ${MAX_WORKPLACES}`,
			[profileId]
		),
		pool.query(
			"SELECT uuid, workplace_id, kind, credential_uuid, email FROM athena_workplace_link WHERE profile_id = ? ORDER BY kind, email, id",
			[profileId]
		),
		connections(profileId),
	]);
	const places = rows.map((r) => {
		const mine = linkRows.filter((l) => Number(l.workplace_id) === Number(r.id));
		return {
			...toWorkplace(r),
			emails: mine.filter((l) => l.kind === "email").map((l) => ({ uuid: l.uuid, email: l.email })),
			// A link outlives a connection that was removed; it says so rather than vanishing.
			connections: mine.filter((l) => l.kind === "credential").map((l) => ({
				uuid: l.uuid,
				...(conns.get(l.credential_uuid) || { credentialUuid: l.credential_uuid, provider: null, label: "A removed connection", account: null, status: "revoked" }),
			})),
		};
	});
	const linked = new Set(linkRows.map((l) => l.credential_uuid).filter(Boolean));
	return { places, available: [...conns.values()].filter((c) => !linked.has(c.credentialUuid)) };
}

async function list(profileId) {
	return (await load(profileId)).places;
}

/**
 * Every workplace with its links, and the connections still unlinked. A
 * connection signed in with an address at a workplace's domain is suggested
 * for that workplace — a hint the person confirms, never a link by itself.
 */
async function overview(profileId) {
	const { places, available } = await load(profileId);
	return {
		workplaces: places,
		available: available.map((c) => {
			const domain = /@([a-z0-9.-]+)/i.exec(c.account || "")?.[1]?.toLowerCase();
			const match = domain && places.find((w) => w.domain && (domain === w.domain || domain.endsWith(`.${w.domain}`)));
			return { ...c, suggestedWorkplace: match ? match.uuid : null };
		}),
	};
}

/**
 * Normalise a submitted workplace, or throw a 400 whose message is safe to
 * show. Absent fields keep their stored value; an empty string clears one.
 */
function normalize(input = {}, existing = null) {
	const name = input.name === undefined ? existing?.name ?? null : trim(input.name, 120);
	if (!name) throw bad("A workplace needs a name.");
	let domain = existing?.domain ?? null;
	if (input.domain !== undefined) {
		domain = input.domain === null || input.domain === "" ? null : hostOf(input.domain);
		if (input.domain && !domain) throw bad("That doesn't look like a domain — use something like vivacitytech.com.");
	}
	return {
		name,
		role: input.role === undefined ? existing?.role ?? null : trim(input.role, 160),
		domain,
		is_primary: input.primary === undefined ? (existing?.primary ? 1 : 0) : input.primary ? 1 : 0,
		notes: input.notes === undefined ? existing?.notes ?? null : trim(input.notes, 500),
	};
}

async function rowByUuid(profileId, uuid) {
	const [rows] = await pool.query(
		`SELECT ${COLUMNS} FROM athena_workplace WHERE profile_id = ? AND uuid = ? LIMIT 1`,
		[profileId, uuid]
	);
	return rows[0] || null;
}

async function byUuid(profileId, uuid) {
	const row = await rowByUuid(profileId, uuid);
	return row ? toWorkplace(row) : null;
}

async function save(profileId, input = {}) {
	const existing = input.uuid ? await byUuid(profileId, String(input.uuid)) : null;
	if (input.uuid && !existing) throw notFound();
	const f = normalize(input, existing);

	if (!existing) {
		const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM athena_workplace WHERE profile_id = ?", [profileId]);
		if (n >= MAX_WORKPLACES) throw bad(`That is already ${MAX_WORKPLACES} workplaces.`);
		// The first one is where they work, until they say otherwise.
		if (n === 0) f.is_primary = 1;
	}
	const [clash] = await pool.query(
		"SELECT uuid FROM athena_workplace WHERE profile_id = ? AND name = ? AND uuid <> ? LIMIT 1",
		[profileId, f.name, existing?.uuid || ""]
	);
	if (clash.length) throw bad(`You already have ${f.name} on your list.`);

	const uuid = existing?.uuid || randomUUID();
	// One primary: marking this one clears the flag everywhere else first.
	if (f.is_primary) {
		await pool.query("UPDATE athena_workplace SET is_primary = 0 WHERE profile_id = ? AND uuid <> ?", [profileId, uuid]);
	}
	if (existing) {
		await pool.query(
			`UPDATE athena_workplace SET name=?, role=?, domain=?, is_primary=?, notes=?
			 WHERE profile_id = ? AND uuid = ?`,
			[f.name, f.role, f.domain, f.is_primary, f.notes, profileId, uuid]
		);
	} else {
		await pool.query(
			`INSERT INTO athena_workplace (uuid, profile_id, name, role, domain, is_primary, notes)
			 VALUES (?,?,?,?,?,?,?)`,
			[uuid, profileId, f.name, f.role, f.domain, f.is_primary, f.notes]
		);
	}
	return byUuid(profileId, uuid);
}

async function remove(profileId, uuid) {
	const row = await rowByUuid(profileId, uuid);
	if (!row) return false;
	await pool.query("DELETE FROM athena_workplace_link WHERE profile_id = ? AND workplace_id = ?", [profileId, row.id]);
	await pool.query("DELETE FROM athena_workplace WHERE profile_id = ? AND id = ?", [profileId, row.id]);
	return true;
}

/**
 * Link a connection ({ credential: uuid }) or an address ({ email }) to one
 * workplace. Exclusive: one already belonging to another workplace is refused
 * with that workplace's name, never moved silently. Linking it again to the
 * same workplace is a no-op.
 */
async function link(profileId, workplaceUuid, input = {}) {
	const row = await rowByUuid(profileId, String(workplaceUuid));
	if (!row) throw notFound();

	let kind, credentialUuid = null, email = null;
	if (input.credential) {
		kind = "credential";
		credentialUuid = String(input.credential);
		// Only the caller's own, linkable, live connection.
		if (!(await connections(profileId)).has(credentialUuid)) throw bad("That connection isn't one of yours that can belong to a workplace.");
	} else if (input.email !== undefined) {
		kind = "email";
		email = emailOf(input.email);
		if (!email) throw bad("That doesn't look like an email address.");
	} else {
		throw bad("Choose a connection or an email address.");
	}

	const [owner] = await pool.query(
		`SELECT w.id, w.name FROM athena_workplace_link l JOIN athena_workplace w ON w.id = l.workplace_id
		  WHERE l.profile_id = ? AND ${kind === "credential" ? "l.credential_uuid" : "l.email"} = ? LIMIT 1`,
		[profileId, credentialUuid || email]
	);
	if (owner.length) {
		if (Number(owner[0].id) === Number(row.id)) return;
		throw bad(`That already belongs to ${owner[0].name}. Unlink it there first.`);
	}
	const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM athena_workplace_link WHERE profile_id = ? AND workplace_id = ?", [profileId, row.id]);
	if (n >= MAX_LINKS) throw bad(`That workplace already has ${MAX_LINKS} links.`);
	await pool.query(
		"INSERT INTO athena_workplace_link (uuid, profile_id, workplace_id, kind, credential_uuid, email) VALUES (?,?,?,?,?,?)",
		[randomUUID(), profileId, row.id, kind, credentialUuid, email]
	);
}

async function unlink(profileId, workplaceUuid, linkUuid) {
	const row = await rowByUuid(profileId, String(workplaceUuid));
	if (!row) throw notFound();
	const [result] = await pool.query(
		"DELETE FROM athena_workplace_link WHERE profile_id = ? AND workplace_id = ? AND uuid = ?",
		[profileId, row.id, String(linkUuid)]
	);
	if (!result.affectedRows) throw Object.assign(new Error("That link isn't on this workplace."), { status: 404 });
}

const quoted = (text, max = 200) => JSON.stringify(String(text).slice(0, max));

/**
 * Where they work, on every adult turn that has any — a few lines, and the
 * thing that lets "my work" mean the right company and a Jira ticket mean the
 * right one. Names, roles and notes are the person's own words, quoted as data.
 */
async function promptBlock(profileId) {
	const places = await list(profileId);
	if (!places.length) return null;
	const lines = [
		"# Where they work",
		"",
		"The workplaces this person listed on the Work page, in their own words. When they say \"work\" without naming one, they mean the primary; if it matters which and it is not clear, ask. A connection or email address listed under a workplace belongs to that workplace only: Jira issues from a site listed there are that company's work, and mail to or from a listed address is that company's mail. A connection listed under no workplace is not tied to one — do not guess which company it serves.",
	];
	for (const w of places) {
		const parts = [quoted(w.name, 120)];
		if (w.role) parts.push(`role ${quoted(w.role, 160)}`);
		if (w.domain) parts.push(w.domain);
		if (w.primary) parts.push("primary");
		lines.push(`- ${parts.join(" · ")}${w.notes ? ` — their note: ${quoted(w.notes)}` : ""}`);
		if (w.emails.length) lines.push(`  Email addresses: ${w.emails.map((e) => e.email).join(", ")}`);
		const live = w.connections.filter((c) => c.provider);
		if (live.length) {
			lines.push(`  Connections: ${live.map((c) => `${c.label}${c.account ? ` (${c.account})` : ""}${c.status === "active" ? "" : ` — ${c.status.replace("_", " ")}`}`).join("; ")}`);
		}
	}
	return lines.join("\n");
}

module.exports = { list, overview, save, remove, link, unlink, promptBlock, normalize, emailOf, accountOf, MAX_WORKPLACES, LINKABLE };
