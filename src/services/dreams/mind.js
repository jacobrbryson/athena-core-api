/**
 * athena_mind — the database Athena designs herself while dreaming.
 *
 * She may create, alter and drop anything in it. What keeps that safe is not
 * a review of her SQL but three things the code does around it:
 *
 *   1. Her statements run on a connection that can only reach athena_mind
 *      (a MySQL user granted rights on that database alone — db/mind-setup.js).
 *      The main connection never executes a statement a model wrote.
 *
 *   2. The facts stay the source of truth. Each night the code rewrites a
 *      mirror of them (`_fact`, plus answered questions in `_clarification`)
 *      and her tables are built FROM that mirror. A bad night costs a rebuild,
 *      never a memory.
 *
 *   3. Forgetting reaches her tables. Every table of hers must carry
 *      `_profile_id` (whose memory a row came from) and `_sources` (a JSON
 *      array of "f:<fact id>" / "q:<question id>"). After each dream, any row
 *      whose sources no longer all exist for that same person is deleted, and
 *      any table without those two columns is dropped. So when someone says
 *      "forget that", the fact goes, and by the next morning so does every row
 *      built on it.
 *
 * Tables whose names start with `_` belong to the code. She reads them; the
 * code recreates them if she drops them and drops any `_` table it didn't make.
 */
const fs = require("node:fs");
const mysql = require("mysql2/promise");

const MIND_DB = process.env.ATHENA_MIND_DB_NAME || "athena_mind";
const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SOURCE = /^[fq]:\d{1,19}$/;

const SYSTEM_TABLES = {
	_fact: `CREATE TABLE IF NOT EXISTS _fact (
    fact_id     BIGINT UNSIGNED NOT NULL,
    profile_id  BIGINT          NOT NULL,
    category    VARCHAR(32)     NOT NULL,
    fact_key    VARCHAR(120)    NOT NULL,
    fact_value  TEXT            NULL,
    updated_at  DATETIME        NULL,
    PRIMARY KEY (fact_id),
    KEY idx_fact_profile (profile_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	_clarification: `CREATE TABLE IF NOT EXISTS _clarification (
    question_id BIGINT UNSIGNED NOT NULL,
    profile_id  BIGINT          NOT NULL,
    question    VARCHAR(500)    NOT NULL,
    answer      TEXT            NULL,
    answered_at DATETIME        NULL,
    PRIMARY KEY (question_id),
    KEY idx_clarification_profile (profile_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	// Her own notes on what each table/view is for. The chat path reads this
	// to decide which of her tables a message is about.
	_catalog: `CREATE TABLE IF NOT EXISTS _catalog (
    object_name  VARCHAR(64)  NOT NULL,
    description  VARCHAR(500) NOT NULL,
    label_column VARCHAR(64)  NULL,
    triggers     JSON         NULL,
    updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (object_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
};

function configured() {
	return Boolean(process.env.ATHENA_MIND_DB_USER && process.env.ATHENA_MIND_DB_PASS);
}

function tlsOptions() {
	if (process.env.DB_TLS_REQUIRED !== "true") return {};
	return {
		ssl: {
			rejectUnauthorized: true,
			verifyIdentity: true,
			...(process.env.DB_TLS_CA_FILE ? { ca: fs.readFileSync(process.env.DB_TLS_CA_FILE, "utf8") } : {}),
		},
	};
}

/**
 * Her connection. Refuses to fall back to the main credentials: a dream run
 * with the owner's user would be a dream with no walls.
 */
async function connect() {
	if (!configured()) throw new Error("ATHENA_MIND_DB_USER / ATHENA_MIND_DB_PASS are not set");
	if (process.env.ATHENA_MIND_DB_USER === process.env.DB_USER) {
		throw new Error("athena_mind must use its own database user, never the main one");
	}
	const conn = await mysql.createConnection({
		host: process.env.ATHENA_MIND_DB_HOST || process.env.DB_HOST,
		user: process.env.ATHENA_MIND_DB_USER,
		password: process.env.ATHENA_MIND_DB_PASS,
		database: MIND_DB,
		port: process.env.DB_PORT || 3306,
		multipleStatements: false,
		dateStrings: true,
		supportBigNumbers: true,
		bigNumberStrings: false,
		...tlsOptions(),
	});
	await conn.query("SET SESSION max_execution_time = 20000, lock_wait_timeout = 15, innodb_lock_wait_timeout = 15");
	return conn;
}

async function ensureSystemTables(conn) {
	for (const ddl of Object.values(SYSTEM_TABLES)) await conn.query(ddl);
}

/** Tables and views in athena_mind, with columns and row counts. */
async function describe(conn) {
	const [objects] = await conn.query(
		`SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`
	);
	const [columns] = await conn.query(
		`SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, COLUMN_KEY AS k
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`
	);
	const byTable = new Map();
	for (const col of columns) {
		if (!byTable.has(col.t)) byTable.set(col.t, []);
		byTable.get(col.t).push({ name: col.c, type: col.type, key: col.k || null });
	}
	const out = [];
	for (const o of objects) {
		const cols = byTable.get(o.name) || [];
		const entry = { name: o.name, kind: o.type === "VIEW" ? "view" : "table", columns: cols, rows: null };
		try {
			const [[r]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${o.name}\``);
			entry.rows = Number(r.n);
		} catch (err) {
			entry.error = String(err.message).slice(0, 160); // e.g. a view over a dropped table
		}
		if (entry.kind === "view") {
			try {
				const [[v]] = await conn.query(`SHOW CREATE VIEW \`${o.name}\``);
				entry.definition = String(v["Create View"] || "").replace(/^.*? VIEW `[^`]+` AS /s, "").slice(0, 800);
			} catch {
				/* definition is a nicety */
			}
		}
		out.push(entry);
	}
	return out;
}

const hasColumn = (entry, name) => entry.columns.some((c) => c.name === name);

/** A table of hers that the purge can hold to account. */
function isCompliant(entry) {
	return hasColumn(entry, "_profile_id") && hasColumn(entry, "_sources");
}

/**
 * Rewrite the mirror from the main database. `facts` and `clarifications`
 * come from the caller (read through the main connection); this function
 * only ever writes into athena_mind.
 */
async function refreshMirror(conn, { facts, clarifications }) {
	await conn.beginTransaction();
	try {
		await conn.query("DELETE FROM _fact");
		for (let i = 0; i < facts.length; i += 500) {
			const chunk = facts.slice(i, i + 500).map((f) => [f.id, f.profile_id, f.category, f.memory_key, f.memory_value, f.updated_at]);
			await conn.query(
				"INSERT INTO _fact (fact_id, profile_id, category, fact_key, fact_value, updated_at) VALUES ?",
				[chunk]
			);
		}
		await conn.query("DELETE FROM _clarification");
		if (clarifications.length) {
			await conn.query(
				"INSERT INTO _clarification (question_id, profile_id, question, answer, answered_at) VALUES ?",
				[clarifications.map((c) => [c.id, c.profile_id, c.question, c.answer, c.answered_at])]
			);
		}
		await conn.commit();
	} catch (err) {
		await conn.rollback().catch(() => undefined);
		throw err;
	}
	return { facts: facts.length, clarifications: clarifications.length };
}

/**
 * Drop what the rules say cannot stay: her tables that can't be purged, and
 * `_` tables the code didn't create. Returns one entry per drop, for the log.
 */
async function guard(conn) {
	await ensureSystemTables(conn);
	const actions = [];
	for (const entry of await describe(conn)) {
		if (entry.kind !== "table") continue;
		let reason = null;
		if (entry.name.startsWith("_")) {
			if (!SYSTEM_TABLES[entry.name]) reason = "tables starting with _ are reserved for the code";
		} else if (!isCompliant(entry)) {
			reason = "every table needs _profile_id and _sources so forgetting can reach it";
		}
		if (!reason) continue;
		const statement = `DROP TABLE \`${entry.name}\``;
		try {
			await conn.query("SET FOREIGN_KEY_CHECKS = 0");
			await conn.query(statement);
			actions.push({ statement, why: reason, ok: true });
		} catch (err) {
			actions.push({ statement, why: reason, ok: false, error: err.message });
		} finally {
			await conn.query("SET FOREIGN_KEY_CHECKS = 1").catch(() => undefined);
		}
	}
	return actions;
}

/**
 * Delete every row whose sources are missing, malformed, or not all this
 * same person's. The one guarantee the whole design leans on.
 */
async function purge(conn) {
	const actions = [];
	for (const entry of await describe(conn)) {
		if (entry.kind !== "table" || entry.name.startsWith("_") || !isCompliant(entry)) continue;
		const statement = `DELETE t FROM \`${entry.name}\` t
WHERE t._profile_id IS NULL OR t._sources IS NULL OR JSON_TYPE(t._sources) <> 'ARRAY' OR JSON_LENGTH(t._sources) = 0
   OR EXISTS (
     SELECT 1 FROM JSON_TABLE(t._sources, '$[*]' COLUMNS (s VARCHAR(40) PATH '$')) j
     WHERE NOT (
       (j.s REGEXP '^f:[0-9]+$' AND EXISTS (SELECT 1 FROM _fact f WHERE f.fact_id = CAST(SUBSTRING(j.s, 3) AS UNSIGNED) AND f.profile_id = t._profile_id))
       OR
       (j.s REGEXP '^q:[0-9]+$' AND EXISTS (SELECT 1 FROM _clarification c WHERE c.question_id = CAST(SUBSTRING(j.s, 3) AS UNSIGNED) AND c.profile_id = t._profile_id))
     )
   )`;
		try {
			const [res] = await conn.query(statement);
			if (res.affectedRows) actions.push({ table: entry.name, statement, deleted: res.affectedRows, ok: true });
		} catch (err) {
			// A table the purge cannot check is a table forgetting cannot reach.
			const drop = `DROP TABLE \`${entry.name}\``;
			await conn.query(drop).catch(() => undefined);
			actions.push({ table: entry.name, statement: drop, ok: false, error: `purge failed (${err.message}); table dropped` });
		}
	}
	return actions;
}

/** Fact ids already referenced by some row of hers. */
async function referencedSources(conn, entries) {
	const seen = new Set();
	for (const entry of entries) {
		if (entry.kind !== "table" || entry.name.startsWith("_") || !isCompliant(entry)) continue;
		const [rows] = await conn.query(`SELECT _sources FROM \`${entry.name}\` LIMIT 20000`);
		for (const r of rows) {
			let list = r._sources;
			if (typeof list === "string") {
				try {
					list = JSON.parse(list);
				} catch {
					list = [];
				}
			}
			if (Array.isArray(list)) for (const s of list) seen.add(String(s));
		}
	}
	return seen;
}

/**
 * Run one of her statements. SELECT-like statements return their first rows
 * so the next round of the dream can see them.
 */
async function runStatement(conn, statement) {
	const sql = String(statement || "").trim().replace(/;\s*$/, "");
	if (!sql) throw new Error("empty statement");
	if (sql.includes(";")) {
		// mysql2 would refuse it anyway with multipleStatements off; say why.
		throw new Error("one statement per step");
	}
	const [result] = await conn.query(sql);
	if (Array.isArray(result)) {
		return { rows: result.slice(0, 25), total: result.length };
	}
	return { affectedRows: result?.affectedRows ?? null };
}

/**
 * Insert-or-update rows she extracted from facts. Code builds the SQL so
 * values are parameters, and checks every row's sources belong to its person.
 */
async function upsertRows(conn, table, rows, { factOwner, clarificationOwner }) {
	if (!IDENT.test(String(table || "")) || table.startsWith("_")) throw new Error(`bad table name: ${table}`);
	if (!Array.isArray(rows) || !rows.length) throw new Error("no rows");
	const accepted = [];
	const rejected = [];
	for (const row of rows.slice(0, 500)) {
		const problem = rowProblem(row, { factOwner, clarificationOwner });
		if (problem) rejected.push(problem);
		else accepted.push(row);
	}
	if (!accepted.length) return { affectedRows: 0, rejected };

	const columns = [...new Set(accepted.flatMap((r) => Object.keys(r)))];
	const bad = columns.find((c) => !/^_?[A-Za-z][A-Za-z0-9_]{0,62}$/.test(c));
	if (bad) throw new Error(`bad column name: ${bad}`);
	const values = accepted.map((r) =>
		columns.map((c) => {
			const v = r[c];
			if (v === undefined) return null;
			if (v !== null && typeof v === "object") return JSON.stringify(v);
			return v;
		})
	);
	const cols = columns.map((c) => `\`${c}\``).join(", ");
	const update = columns.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(", ");
	const [res] = await conn.query(`INSERT INTO \`${table}\` (${cols}) VALUES ? ON DUPLICATE KEY UPDATE ${update}`, [values]);
	return { affectedRows: res.affectedRows, inserted: accepted.length, rejected };
}

function rowProblem(row, { factOwner, clarificationOwner }) {
	if (!row || typeof row !== "object" || Array.isArray(row)) return "row is not an object";
	const pid = Number(row._profile_id);
	if (!Number.isInteger(pid)) return "row has no _profile_id";
	const sources = row._sources;
	if (!Array.isArray(sources) || !sources.length) return "row has no _sources";
	for (const s of sources) {
		if (!SOURCE.test(String(s))) return `bad source ${s}`;
		const id = Number(String(s).slice(2));
		const owner = String(s)[0] === "f" ? factOwner.get(id) : clarificationOwner.get(id);
		if (owner === undefined) return `unknown source ${s}`;
		if (owner !== pid) return `source ${s} belongs to someone else`;
	}
	return null;
}

async function describeObject(conn, { object, description, label_column, triggers }) {
	if (!IDENT.test(String(object || "")) || object.startsWith("_")) throw new Error(`bad object name: ${object}`);
	if (!description) throw new Error("describe needs a description");
	if (label_column && !IDENT.test(String(label_column).replace(/^_/, "x"))) throw new Error("bad label_column");
	const words = (Array.isArray(triggers) ? triggers : [])
		.map((t) => String(t).toLowerCase().trim())
		// Everyday words, not column names: "_profile_id" or "person_id" in a
		// message would never be how anyone asks about their family.
		.filter((t) => t && t.length <= 40 && !t.includes("_"))
		.slice(0, 20);
	const [res] = await conn.query(
		`INSERT INTO _catalog (object_name, description, label_column, triggers) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE description = VALUES(description), label_column = VALUES(label_column), triggers = VALUES(triggers)`,
		[object, String(description).slice(0, 500), label_column || null, JSON.stringify(words)]
	);
	return { affectedRows: res.affectedRows };
}

/** Catalog entries whose object no longer exists are noise in every prompt. */
async function pruneCatalog(conn) {
	const [res] = await conn.query(
		`DELETE FROM _catalog WHERE object_name NOT IN (
       SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE())`
	);
	return res.affectedRows || 0;
}

module.exports = {
	MIND_DB,
	IDENT,
	SYSTEM_TABLES,
	configured,
	connect,
	ensureSystemTables,
	describe,
	isCompliant,
	refreshMirror,
	guard,
	purge,
	referencedSources,
	runStatement,
	upsertRows,
	rowProblem,
	describeObject,
	pruneCatalog,
};
