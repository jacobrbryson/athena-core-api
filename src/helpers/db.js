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

module.exports = pool;
