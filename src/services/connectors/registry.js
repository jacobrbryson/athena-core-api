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
 *   scopeSeparator       " " for most; some providers accept comma
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

/**
 * Google's token response carries an id_token when `openid` was requested. Its
 * unverified payload is fine here — it came straight from the token endpoint
 * over TLS and is only used as a display label and account key.
 */
function googleIdentity(tokens) {
	if (typeof tokens?.id_token !== "string") return null;
	const part = tokens.id_token.split(".")[1];
	if (!part) return null;
	try {
		const claims = JSON.parse(Buffer.from(part, "base64").toString("utf8"));
		if (!claims.sub) return null;
		return {
			externalAccountId: String(claims.sub),
			displayName: claims.email || claims.name || null,
			email: claims.email ? String(claims.email).toLowerCase() : null,
		};
	} catch {
		return null;
	}
}

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
  gmail: {
    id: 'gmail', label: 'Gmail',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke', revokeMethod: 'POST', revokeBody: token => ({ token }),
    // gmail.modify supersedes readonly (it includes read access) but both are
    // listed explicitly, same as google_calendar layering calendar.events
    // alongside calendar.readonly below — it documents intent at the call
    // site rather than relying on one scope's coverage of another. Accounts
    // linked before this widened hold the old readonly-only grant and keep
    // working for reads; a label write 403s and connectors/gmail.js re-types
    // that into needs_reauth (see asWriteAuthError there), same pattern as
    // googleCalendar.js.
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify'], scopeSeparator: ' ',
    clientIdSecret: 'GOOGLE_OAUTH_CLIENT_ID', clientSecretSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
    pkce: true, authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    tokenAuth: 'body', consentType: null, rotatesRefreshToken: false,
    apiBase: 'https://gmail.googleapis.com/gmail/v1', identify: null,
    identifyAsync: async (_tokens, { accessToken, apiBase }) => {
      const response = await fetch(`${apiBase}/users/me/profile`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) return null;
      const data = await response.json();
      return data.emailAddress ? { externalAccountId: data.emailAddress, displayName: data.emailAddress } : null;
    },
  },
  jira: {
    id: 'jira', label: 'Jira Cloud', authorizeUrl: 'https://auth.atlassian.com/authorize', tokenUrl: 'https://auth.atlassian.com/oauth/token',
    revokeUrl: null, scopes: ['read:jira-work', 'offline_access'], scopeSeparator: ' ',
    clientIdSecret: 'JIRA_CLIENT_ID', clientSecretSecret: 'JIRA_CLIENT_SECRET', pkce: false,
    authorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' }, tokenAuth: 'body', tokenFormat: 'json',
    consentType: null, rotatesRefreshToken: true, apiBase: 'https://api.atlassian.com', identify: null,
  },
  slack: {
    id: 'slack', label: 'Slack', authorizeUrl: 'https://slack.com/oauth/v2/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.access',
    revokeUrl: null, scopes: ['search:read'], scopeParameter: 'user_scope', scopeSeparator: ',',
    clientIdSecret: 'SLACK_CLIENT_ID', clientSecretSecret: 'SLACK_CLIENT_SECRET', pkce: false,
    authorizeParams: {}, tokenAuth: 'body', consentType: null, rotatesRefreshToken: true, apiBase: 'https://slack.com/api',
    // Initial user grants are nested; a rotated user token is top-level.
    tokenPayload: (body, refreshing) => body.ok === false ? body : body.authed_user || (refreshing && body.token_type === 'user' ? body : {}),
    identify: body => body.authed_user?.id ? { externalAccountId: body.authed_user.id, displayName: body.team?.name || 'Slack' } : null,
  },
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
		// calendar.events is read AND write on events, and supersedes
		// calendar.events.readonly. It is what the action layer's
		// create_calendar_event needs; calendar.readonly stays for the
		// calendarList fan-out, which events scope alone does not cover.
		//
		// Accounts linked before this changed hold the old readonly pair and
		// keep working for reads. They cannot write, and Google says so with
		// 403 insufficientPermissions — googleCalendar.js re-types that into
		// `needs_reauth` so the person is asked to re-link for writing rather
		// than told their link is broken. include_granted_scopes below makes
		// that re-link additive.
		scopes: [
			"https://www.googleapis.com/auth/calendar.readonly",
			"https://www.googleapis.com/auth/calendar.events",
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
		identify: googleIdentity,
	},

	// -----------------------------------------------------------------
	// Google Contacts (People API) — read-only
	// -----------------------------------------------------------------
	google_contacts: {
		id: "google_contacts",
		label: "Google Contacts",
		authorizeUrl: env(
			"GOOGLE_OAUTH_AUTHORIZE_URL",
			"https://accounts.google.com/o/oauth2/v2/auth"
		),
		tokenUrl: env("GOOGLE_OAUTH_TOKEN_URL", "https://oauth2.googleapis.com/token"),
		revokeUrl: env("GOOGLE_OAUTH_REVOKE_URL", "https://oauth2.googleapis.com/revoke"),
		revokeMethod: "POST",
		revokeBody: (token) => ({ token }),
		// contacts.readonly only: names, phones, emails, relations, photos,
		// birthdays and addresses of the person's own contacts. Nothing here can
		// write a contact, and there is no action that would want to.
		scopes: [
			"https://www.googleapis.com/auth/contacts.readonly",
			"openid",
			"email",
		],
		scopeSeparator: " ",
		clientIdSecret: "GOOGLE_OAUTH_CLIENT_ID",
		clientSecretSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
		pkce: true,
		authorizeParams: {
			access_type: "offline",
			prompt: "consent",
			include_granted_scopes: "true",
		},
		tokenAuth: "body",
		consentType: null,
		rotatesRefreshToken: false,
		apiBase: env("GOOGLE_PEOPLE_API_BASE", "https://people.googleapis.com/v1"),
		identify: googleIdentity,
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
			// /v2/cycle carries day strain, and Whoop scopes it separately from
			// recovery. Omitting it did not fail at link time — it failed on the
			// first dashboard read, with a 401 that http.js could only read as a
			// revoked grant, so every page load flagged a healthy link
			// needs_reauth.
			"read:cycles",
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

/**
 * Providers that share one upstream grant and are linked together.
 *
 * Gmail, Calendar and Contacts are one Google OAuth client, and with
 * include_granted_scopes one person's grant to it is a single thing: revoking
 * any token revokes all of it. So they are consented to on one screen (the
 * one sign-in opens), each member stored as its own credential so every
 * connector keeps asking for exactly the provider it reads, and a member the
 * person unticked on Google's screen is simply not linked — they can elevate
 * it later from its own row in Connected apps.
 *
 * `accountKey` says which identity a member's existing links are keyed by:
 * Gmail's rows predate this and hold the address; the others hold `sub`.
 */
const GROUPS = {
	google: {
		id: "google",
		label: "Google",
		members: ["gmail", "google_calendar", "google_contacts"],
		// Always asked, whatever the members are: the id_token is how the
		// callback learns which Google account consented.
		identityScopes: ["openid", "email", "profile"],
		// The group returns through a member's callback, which is already a
		// registered redirect URI on the Google OAuth client — a new
		// /integrations/google/callback would be one more URI to keep in sync
		// with the console, and a redirect_uri_mismatch when it isn't. The
		// callback tells the two flows apart by the state's own provider.
		callbackVia: "google_calendar",
		accountKey: { gmail: "email", google_calendar: "sub", google_contacts: "sub" },
	},
};

const GROUP_IDS = Object.freeze(Object.keys(GROUPS));

function isGroup(id) {
	return Object.prototype.hasOwnProperty.call(GROUPS, id);
}

function getGroup(id) {
	if (!isGroup(id)) {
		throw Object.assign(new Error(`Unknown integration group: ${id}`), { status: 404 });
	}
	return GROUPS[id];
}

/** The group a provider belongs to, or null. */
function groupOf(providerId) {
	return GROUP_IDS.find((g) => GROUPS[g].members.includes(providerId)) || null;
}

/** Scopes a member needs beyond identity — what "granted" is judged on. */
function dataScopes(providerId) {
	const identity = new Set(["openid", "email", "profile"]);
	return getProvider(providerId).scopes.filter((s) => !identity.has(s));
}

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
		group: groupOf(p.id),
	};
}

module.exports = {
	PROVIDERS,
	PROVIDER_IDS,
	GROUPS,
	GROUP_IDS,
	getProvider,
	isProvider,
	getGroup,
	isGroup,
	groupOf,
	dataScopes,
	describe,
	googleIdentity,
};
