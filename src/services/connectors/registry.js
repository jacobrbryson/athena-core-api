/**
 * Connector registry — everything provider-specific about an OAuth link.
 *
 * `oauth.js` is deliberately generic; every quirk lives here so adding a
 * provider is a descriptor, not a new code path. Endpoints were taken from
 * the providers' current docs (September 2026) and can be overridden by env
 * for sandbox hosts.
 *
 * Descriptor fields:
 *   id, label            identity and display name
 *   authorizeUrl         where the browser is sent to consent
 *   tokenUrl             code -> token, and refresh_token -> token
 *   revokeUrl            best-effort revocation on disconnect (null if none)
 *   revokeMethod/Body    how this provider wants a revocation expressed
 *   scopes               requested scopes
 *   scopeSeparator       " " for most; Strava accepts comma
 *   clientIdSecret       app-level secret name holding the client id
 *   clientSecretSecret   app-level secret name holding the client secret
 *   pkce                 send a PKCE challenge (defence in depth for a
 *                        confidential client; only where supported)
 *   authorizeParams      extra query params on the authorize request
 *   tokenAuth            "body" (client creds in the form) or "basic"
 *   consentType          a family consent that must exist before linking
 *   rotatesRefreshToken  provider returns a NEW refresh token on refresh,
 *                        which must be persisted or the link dies
 *   identify(tokens)     -> { externalAccountId, displayName }
 *   apiBase              base URL for this provider's data endpoints (Phase 4)
 */

const env = (name, fallback) => {
	const raw = process.env[name];
	return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
};

/** Providers whose token response already identifies the account. */
function identityFromField(field, idKey, nameKeys) {
	return (tokens) => {
		const obj = tokens && tokens[field];
		if (!obj || typeof obj !== "object") return null;
		const id = obj[idKey];
		if (id === undefined || id === null) return null;
		const name = nameKeys.map((k) => obj[k]).filter(Boolean).join(" ").trim();
		return { externalAccountId: String(id), displayName: name || null };
	};
}

const PROVIDERS = {
	// -----------------------------------------------------------------
	// Google Calendar
	// -----------------------------------------------------------------
	google_calendar: {
		id: "google_calendar",
		label: "Google Calendar",
		authorizeUrl: env(
			"GOOGLE_OAUTH_AUTHORIZE_URL",
			"https://accounts.google.com/o/oauth2/v2/auth"
		),
		tokenUrl: env("GOOGLE_OAUTH_TOKEN_URL", "https://oauth2.googleapis.com/token"),
		revokeUrl: env("GOOGLE_OAUTH_REVOKE_URL", "https://oauth2.googleapis.com/revoke"),
		revokeMethod: "POST",
		revokeBody: (token) => ({ token }),
		scopes: [
			"https://www.googleapis.com/auth/calendar.readonly",
			"https://www.googleapis.com/auth/calendar.events.readonly",
			"openid",
			"email",
		],
		scopeSeparator: " ",
		clientIdSecret: "GOOGLE_OAUTH_CLIENT_ID",
		clientSecretSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
		pkce: true,
		// access_type=offline + prompt=consent is the ONLY reliable way to get
		// a refresh token from Google. Without prompt=consent a returning user
		// re-consents silently and the response carries no refresh token —
		// which is why credentials.put() preserves an existing one.
		authorizeParams: {
			access_type: "offline",
			prompt: "consent",
			include_granted_scopes: "true",
		},
		tokenAuth: "body",
		consentType: null,
		rotatesRefreshToken: false,
		apiBase: env("GOOGLE_CALENDAR_API_BASE", "https://www.googleapis.com/calendar/v3"),
		identify: (tokens) => {
			// Google returns an id_token; its unverified payload is fine here —
			// it came straight from the token endpoint over TLS and is only
			// used as a display label and account key.
			if (typeof tokens.id_token !== "string") return null;
			const part = tokens.id_token.split(".")[1];
			if (!part) return null;
			try {
				const claims = JSON.parse(Buffer.from(part, "base64").toString("utf8"));
				if (!claims.sub) return null;
				return {
					externalAccountId: String(claims.sub),
					displayName: claims.email || claims.name || null,
				};
			} catch {
				return null;
			}
		},
	},

	// -----------------------------------------------------------------
	// Strava
	// -----------------------------------------------------------------
	strava: {
		id: "strava",
		label: "Strava",
		authorizeUrl: env("STRAVA_AUTHORIZE_URL", "https://www.strava.com/oauth/authorize"),
		tokenUrl: env("STRAVA_TOKEN_URL", "https://www.strava.com/oauth/token"),
		// /oauth/revoke supersedes /oauth/deauthorize as of June 2026.
		revokeUrl: env("STRAVA_REVOKE_URL", "https://www.strava.com/oauth/revoke"),
		revokeMethod: "POST",
		revokeBody: (token) => ({ access_token: token }),
		scopes: ["read", "activity:read"],
		scopeSeparator: ",",
		clientIdSecret: "STRAVA_CLIENT_ID",
		clientSecretSecret: "STRAVA_CLIENT_SECRET",
		pkce: false,
		authorizeParams: { approval_prompt: "auto" },
		tokenAuth: "body",
		// Workout data is health data about a Guardian.
		consentType: "health_data",
		// Strava issues a new refresh token on every refresh. Failing to store
		// it silently breaks the link at the next expiry.
		rotatesRefreshToken: true,
		apiBase: env("STRAVA_API_BASE", "https://www.strava.com/api/v3"),
		identify: identityFromField("athlete", "id", ["firstname", "lastname"]),
	},

	// -----------------------------------------------------------------
	// Whoop
	// -----------------------------------------------------------------
	whoop: {
		id: "whoop",
		label: "Whoop",
		authorizeUrl: env(
			"WHOOP_AUTHORIZE_URL",
			"https://api.prod.whoop.com/oauth/oauth2/auth"
		),
		tokenUrl: env("WHOOP_TOKEN_URL", "https://api.prod.whoop.com/oauth/oauth2/token"),
		// Whoop revokes through an authenticated API call, not an OAuth revoke
		// endpoint, so disconnect only clears our side. Documented, not silent.
		revokeUrl: null,
		scopes: [
			"read:recovery",
			"read:sleep",
			"read:workout",
			"read:profile",
			// REQUIRED for a refresh token — without it the link dies in an hour.
			"offline",
		],
		scopeSeparator: " ",
		clientIdSecret: "WHOOP_CLIENT_ID",
		clientSecretSecret: "WHOOP_CLIENT_SECRET",
		pkce: true,
		authorizeParams: {},
		tokenAuth: "body",
		consentType: "health_data",
		rotatesRefreshToken: true,
		apiBase: env("WHOOP_API_BASE", "https://api.prod.whoop.com/developer"),
		identify: null,
		// Whoop's token response says nothing about the account, so identity
		// needs an authenticated call. Inlined rather than delegated to
		// whoop.js: that module reaches the API through http.js -> oauth.js ->
		// registry, and importing it here would close the cycle.
		identifyAsync: async (tokens, { accessToken, apiBase }) => {
			const response = await fetch(`${apiBase}/v2/user/profile/basic`, {
				headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
			});
			if (!response.ok) return null;
			const data = await response.json();
			if (data?.user_id === undefined || data?.user_id === null) return null;
			const name = [data.first_name, data.last_name].filter(Boolean).join(" ").trim();
			return {
				externalAccountId: String(data.user_id),
				displayName: name || data.email || null,
			};
		},
	},
};

/** Every provider this build can link. */
const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

function getProvider(id) {
	const provider = PROVIDERS[id];
	if (!provider) {
		throw Object.assign(new Error(`Unknown integration provider: ${id}`), {
			status: 404,
		});
	}
	return provider;
}

function isProvider(id) {
	return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/** Safe descriptor for the UI — no secret names, no endpoints. */
function describe(id) {
	const p = getProvider(id);
	return {
		provider: p.id,
		label: p.label,
		scopes: p.scopes,
		requires_consent: p.consentType || null,
	};
}

module.exports = { PROVIDERS, PROVIDER_IDS, getProvider, isProvider, describe };
