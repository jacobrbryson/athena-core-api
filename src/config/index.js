module.exports = {
	API_PORT: process.env.API_PORT || 8080,
	PUBLIC_SESSION_MESSAGE_DAILY_LIMIT:
		process.env.PUBLIC_SESSION_MESSAGE_DAILY_LIMIT || 100,
	PUBLIC_IP_MESSAGE_DAILY_LIMIT:
		process.env.PUBLIC_IP_MESSAGE_DAILY_LIMIT || 300,
	JWT_SECRET: process.env.JWT_SECRET || "",
	RECAPTCHA_SECRET: process.env.RECAPTCHA_SECRET || "",
	RECAPTCHA_PROJECT_ID: process.env.RECAPTCHA_PROJECT_ID || "",
	RECAPTCHA_SITE_KEY: process.env.RECAPTCHA_SITE_KEY || "",

	// --- External integrations (Family Chores app, etc.) ---
	// Key used to encrypt partner API tokens at rest (see helpers/crypto.js).
	INTEGRATION_ENC_KEY: process.env.INTEGRATION_ENC_KEY || "",
	// Default base URL for the Family Chores public API. A per-link override
	// may be supplied at connect time; this is the fallback.
	FAMILY_CHORES_API_BASE:
		process.env.FAMILY_CHORES_API_BASE || "https://api.familychores.app",
	// Shared secret the Family Chores backend must send (X-Partner-Key) to the
	// public connect endpoint. The connect endpoint provisions/links Athena
	// accounts, so this gates it to the trusted partner. Enforced when set;
	// when unset, connect logs a warning and allows (local dev only).
	FAMILY_CHORES_PARTNER_SECRET: process.env.FAMILY_CHORES_PARTNER_SECRET || "",
	// When true (default), Athena uses Gemini function-calling tools to pick the
	// best Family Chores API calls per question. Set FAMILY_CHORES_TOOLS_ENABLED
	// to "false" to force the fixed-window snapshot path instead.
	FAMILY_CHORES_TOOLS_ENABLED:
		process.env.FAMILY_CHORES_TOOLS_ENABLED !== "false",
	// Family Chores roles allowed to establish a link (only parents/admins).
	// Comma-separated; matched case-insensitively against /me's `role`.
	FAMILY_CHORES_ADMIN_ROLES: (
		process.env.FAMILY_CHORES_ADMIN_ROLES || "parent,admin,owner,guardian"
	)
		.split(",")
		.map((r) => r.trim().toLowerCase())
		.filter(Boolean),

	// Guardian IDs allowed to reset their own trail-mission progress in-app
	// (the Guardians dev menu). Defaults to the seeded test account; full
	// resets for any account go through `npm run reset:trail`.
	TRAIL_RESET_GUARDIAN_IDS: (process.env.TRAIL_RESET_GUARDIAN_IDS || "12345678")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean),
};
