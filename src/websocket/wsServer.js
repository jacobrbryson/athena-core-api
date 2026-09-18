const { WebSocketServer } = require("ws");
const url = require("url");
const { decodeUserToken } = require("../middleware/auth");
const { extractIp } = require("../helpers/utils");

const clients = new Map(); // sessionId => Set<ws>

// Guardian-keyed registry: every socket a guardian credential has open, across
// ALL of their devices/sessions. A family shares one credential on several
// devices at once, so cross-device fan-out (e.g. trail-mission updates) keys
// on guardian_id rather than sessionId.
const guardianClients = new Map(); // guardian_id => Set<ws>

// Adventure-keyed registry: every socket belonging to ANY guardian playing a
// given campaign. Mission 3's index is network-shared — one Guardian reporting
// a card advances the index for everyone — so its updates fan out per
// adventure rather than per credential.
const adventureClients = new Map(); // adventure_key => Set<ws>

// Account-keyed registry: every socket a signed-in adult has open, across all
// of their tabs and sessions. The Companion dashboard updates itself from
// pushes rather than a refresh button, and the things that move it (a proposal
// answered, an app connected) happen in request handlers that know the caller
// but not which chat session their dashboard happens to be sitting in.
const userClients = new Map(); // google_id => Set<ws>

function sendToSockets(sockets, payload) {
	if (!sockets || !sockets.size) return;
	const serialized = JSON.stringify(payload);
	for (const ws of sockets) {
		if (ws.readyState === ws.OPEN) {
			ws.send(serialized);
		}
	}
}

/**
 * Push a payload to every open socket belonging to a guardian credential —
 * all devices, all sessions. No-op when the guardian has no sockets (those
 * devices catch up over the mission staleness poll instead).
 */
function broadcastToGuardian(guardianId, payload) {
	sendToSockets(guardianClients.get(guardianId), payload);
}

/**
 * Push a payload to every Guardian playing an adventure, across all their
 * devices. Used for shared mission state: when one Guardian finds an index
 * card, all eight phones need to see it appear.
 */
function broadcastToAdventure(adventureKey, payload) {
	sendToSockets(adventureClients.get(adventureKey), payload);
}

/**
 * Push a payload to every socket belonging to one signed-in account. No-op
 * when nothing is open — the Companion dashboard also re-reads on focus, so a
 * missed push costs freshness, never correctness.
 */
function broadcastToUser(googleId, payload) {
	if (!googleId) return;
	sendToSockets(userClients.get(String(googleId)), payload);
}

/** Tell an account's open dashboards that their underlying data moved. */
function pushDashboardUpdate(googleId, reason = null) {
	broadcastToUser(googleId, { rpc: "dashboardUpdated", reason });
}

function startWebSocketServer(server) {
	const wss = new WebSocketServer({ server });

	wss.on("connection", async (ws, req) => {
		const { query } = url.parse(req.url, true);
		const sessionId = query.sessionId;

		if (!sessionId) {
			ws.close();
			return;
		}

		const authHeader =
			req.headers["x-user-authorization"] || req.headers.authorization;
		const token =
			authHeader && authHeader.startsWith("Bearer ")
				? authHeader.slice("Bearer ".length)
				: null;

		const requestIp = extractIp(req);
		const decoded = decodeUserToken(token, requestIp);
		if (!decoded) {
			console.warn("WS refused: invalid or mismatched token/IP");
			ws.close();
			return;
		}

		try {
			if (!(await require("../security/access").allowed(decoded))) {
				ws.close(1008, "Guardian access or owner approval required");
				return;
			}
		} catch {
			ws.close(1011, "Access verification unavailable");
			return;
		}
		if (ws.readyState !== ws.OPEN) return;
		const sessionClients = clients.get(sessionId) || new Set();
		sessionClients.add(ws);
		clients.set(sessionId, sessionClients);

		// Guardian sockets (session JWT or ws-ticket — both carry guardian_id)
		// also register under the credential for cross-device broadcasts.
		const guardianId =
			decoded.kind === "guardian" && decoded.guardian_id
				? String(decoded.guardian_id)
				: null;
		if (guardianId) {
			const guardianSet = guardianClients.get(guardianId) || new Set();
			guardianSet.add(ws);
			guardianClients.set(guardianId, guardianSet);
		}

		// ...and under the account, for dashboard pushes to every open tab.
		const googleId = decoded.google_id ? String(decoded.google_id) : null;
		if (googleId) {
			const userSet = userClients.get(googleId) || new Set();
			userSet.add(ws);
			userClients.set(googleId, userSet);
		}

		// ...and under their adventure, for network-shared mission fan-out.
		const adventureKey =
			decoded.kind === "guardian" && decoded.adventure_key
				? String(decoded.adventure_key)
				: null;
		if (adventureKey) {
			const adventureSet = adventureClients.get(adventureKey) || new Set();
			adventureSet.add(ws);
			adventureClients.set(adventureKey, adventureSet);
		}

		console.log(
			`WS connected for session ${sessionId}. clients=${sessionClients.size}`
		);

		ws.send(
			JSON.stringify({
				type: "system",
				text: "Welcome to the chat WebSocket",
			})
		);

		ws.on("close", () => {
			const currentClients = clients.get(sessionId);
			if (currentClients) {
				currentClients.delete(ws);
				if (currentClients.size === 0) {
					clients.delete(sessionId);
				}
			}
			if (guardianId) {
				const guardianSet = guardianClients.get(guardianId);
				if (guardianSet) {
					guardianSet.delete(ws);
					if (guardianSet.size === 0) {
						guardianClients.delete(guardianId);
					}
				}
			}
			if (googleId) {
				const userSet = userClients.get(googleId);
				if (userSet) {
					userSet.delete(ws);
					if (userSet.size === 0) {
						userClients.delete(googleId);
					}
				}
			}
			if (adventureKey) {
				const adventureSet = adventureClients.get(adventureKey);
				if (adventureSet) {
					adventureSet.delete(ws);
					if (adventureSet.size === 0) {
						adventureClients.delete(adventureKey);
					}
				}
			}
			console.log(
				`WS disconnected: ${sessionId}. clients=${
					clients.get(sessionId)?.size || 0
				}`
			);
		});
	});

	return clients;
}

module.exports = {
	startWebSocketServer,
	broadcastToGuardian,
	broadcastToAdventure,
	broadcastToUser,
	pushDashboardUpdate,
};
