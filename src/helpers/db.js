// db.js
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
	host: process.env.DB_HOST,
	user: process.env.DB_USER,
	password: process.env.DB_PASS,
	database: process.env.DB_NAME,
	port: process.env.DB_PORT || 3306,
	waitForConnections: true,
	connectionLimit: 10, // ✅ safe for Cloud Run
	maxIdle: 5, // ✅ prevents Cloud SQL from killing idle conns
	idleTimeout: 60000, // 60s
	queueLimit: 0,
});

module.exports = pool;
