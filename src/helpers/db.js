// db.js
const mysql = require("mysql2/promise");

const connection = {
	host: process.env.DB_HOST,
	user: process.env.DB_USER,
	password: process.env.DB_PASS,
	database: process.env.DB_NAME,
	port: process.env.DB_PORT || 3306,
	// DATETIMEs are stored as UTC (prod runs in UTC). Without this, a process
	// in another zone reads token expiries hours off and stops refreshing them.
	timezone: 'Z',
	...(process.env.DB_TLS_REQUIRED === 'true' ? { ssl: {
		rejectUnauthorized: true,
		verifyIdentity: true,
		...(process.env.DB_TLS_CA_FILE ? { ca: require('node:fs').readFileSync(process.env.DB_TLS_CA_FILE, 'utf8') } : {}),
	} } : {}),
};

const pool = mysql.createPool({
	...connection,
	waitForConnections: true,
	connectionLimit: 10, // ✅ safe for Cloud Run
	maxIdle: 5, // ✅ prevents Cloud SQL from killing idle conns
	idleTimeout: 60000, // 60s
	queueLimit: 0,
});

// A connection outside the pool, for holding an advisory lock while the work it
// guards queries the pool: taken from the pool, ten holders could use every
// connection and wait forever for an eleventh. Closing it releases the lock.
pool.lockConnection = () => mysql.createConnection(connection);

// Every pool query inside a traced turn is counted and timed on that turn
// (services/perfTrace): a counter bump and, for the slowest few, the
// statement's shape — never its parameters. Outside a turn this is a single
// lookup and the original call, untouched.
const perfTrace = require("../services/perfTrace");
const { performance } = require("node:perf_hooks");
for (const method of ["query", "execute"]) {
	if (typeof pool[method] !== "function") continue;
	const original = pool[method].bind(pool);
	pool[method] = function traced(sql, ...rest) {
		if (!perfTrace.current()) return original(sql, ...rest);
		const started = performance.now();
		const result = original(sql, ...rest);
		if (typeof result?.then !== "function") return result;
		result.then(
			() => perfTrace.dbQuery(sql, performance.now() - started, false),
			() => perfTrace.dbQuery(sql, performance.now() - started, true),
		);
		return result;
	};
}

module.exports = pool;
