// db.js
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
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
	waitForConnections: true,
	connectionLimit: 10, // ✅ safe for Cloud Run
	maxIdle: 5, // ✅ prevents Cloud SQL from killing idle conns
	idleTimeout: 60000, // 60s
	queueLimit: 0,
});

module.exports = pool;
