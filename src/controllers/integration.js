const integrationService = require("../services/integration");

function sendError(res, err, fallback = "Integration request failed") {
	const status = Number.isInteger(err?.status) ? err.status : 500;
	if (status >= 500) console.error("[integration]", err);
	return res
		.status(status)
		.json({ success: false, message: err?.message || fallback });
}

/** Authenticated: current link status for the acting user. */
async function getFamilyChoresStatus(req, res) {
	try {
		const status = await integrationService.getStatus(
			req.user,
			integrationService.PROVIDER_FAMILY_CHORES
		);
		return res.json({ success: true, ...status });
	} catch (err) {
		return sendError(res, err, "Failed to load integration status");
	}
}

/** Authenticated: disconnect the Family Chores link. */
async function disconnectFamilyChores(req, res) {
	try {
		const result = await integrationService.disconnect(
			req.user,
			integrationService.PROVIDER_FAMILY_CHORES
		);
		return res.json({ success: true, ...result });
	} catch (err) {
		return sendError(res, err, "Failed to disconnect");
	}
}

/**
 * PUBLIC (partner-initiated): the Family Chores backend posts its API token
 * with the shared partner secret. Athena verifies the token, requires a
 * parent/admin role, and connects/creates an Athena account by email.
 */
async function connectFamilyChores(req, res) {
	try {
		const { apiToken, token, baseUrl, scopes } = req.body || {};
		const partnerSecret =
			req.headers["x-partner-key"] || req.body?.partnerSecret;
		const result = await integrationService.connectFamilyChores({
			partnerSecret,
			apiToken: apiToken || token,
			baseUrl,
			scopes,
		});
		return res.status(201).json({ success: true, ...result });
	} catch (err) {
		return sendError(res, err, "Failed to connect Family Chores");
	}
}

/**
 * PUBLIC (partner-initiated): the Family Chores backend severs a link it owns
 * by email, playerId, or apiToken, authorized by the shared partner secret.
 */
async function disconnectFamilyChoresByPartner(req, res) {
	try {
		const { email, playerId, apiToken, token, baseUrl } = req.body || {};
		const partnerSecret =
			req.headers["x-partner-key"] || req.body?.partnerSecret;
		const result = await integrationService.disconnectByPartner({
			partnerSecret,
			email,
			playerId,
			apiToken: apiToken || token,
			baseUrl,
		});
		return res.json({ success: true, ...result });
	} catch (err) {
		return sendError(res, err, "Failed to disconnect Family Chores");
	}
}

/**
 * PUBLIC (partner-initiated): Family Chores passes context; Athena (Gemini)
 * returns AI-generated chore suggestions. Authorized by the partner secret.
 */
async function suggestChores(req, res) {
	try {
		const { child, existingChores, count, context } = req.body || {};
		const partnerSecret =
			req.headers["x-partner-key"] || req.body?.partnerSecret;
		const result = await integrationService.suggestChores({
			partnerSecret,
			child,
			existingChores,
			count,
			context,
		});
		return res.json({ success: true, ...result });
	} catch (err) {
		return sendError(res, err, "Failed to generate chore suggestions");
	}
}

/**
 * PUBLIC (partner-initiated): Family Chores passes a sanitized context payload;
 * Athena (Gemini) returns STRUCTURED ghost-chore suggestions. Authorized by the
 * partner secret. The whole body (minus the secret) is the context.
 */
async function suggestGhostChores(req, res) {
	try {
		const partnerSecret =
			req.headers["x-partner-key"] || req.body?.partnerSecret;
		const { partnerSecret: _ignored, ...context } = req.body || {};
		const result = await integrationService.suggestGhostChores({
			partnerSecret,
			...context,
		});
		return res.json({ success: true, ...result });
	} catch (err) {
		return sendError(res, err, "Failed to generate ghost chore suggestions");
	}
}

/**
 * PUBLIC (partner-initiated): record a distilled, family-visible preference in
 * the linked Athena child's memory when a Family Chores Athena suggestion is
 * accepted. Best-effort — always 200 with { remembered } so the caller never
 * has to handle this as an error.
 */
async function rememberFamilyChores(req, res) {
	try {
		const { email, playerId, signal } = req.body || {};
		const partnerSecret =
			req.headers["x-partner-key"] || req.body?.partnerSecret;
		const result = await integrationService.rememberPreference({
			partnerSecret,
			email,
			playerId,
			signal,
		});
		return res.json({ success: true, ...result });
	} catch (err) {
		return sendError(res, err, "Failed to record preference");
	}
}

/**
 * PUBLIC (partner): list the parent's Athena children so Family Chores can
 * present a picker when a child can't be auto-matched by email.
 */
async function listAthenaChildren(req, res) {
	try {
		const { email, childEmail } = req.body || {};
		const partnerSecret =
			req.headers["x-partner-key"] || req.body?.partnerSecret;
		const result = await integrationService.listAthenaChildren({
			partnerSecret,
			email,
			childEmail,
		});
		return res.json({ success: true, ...result });
	} catch (err) {
		return sendError(res, err, "Failed to list Athena children");
	}
}

/**
 * PUBLIC (partner): link a Family Chores child player to an Athena child
 * profile (matched by email, selected by uuid, or newly created). On a 409
 * the response carries the children list so the partner can prompt a choice.
 */
async function connectAthenaChild(req, res) {
	try {
		const { email, playerId, displayName, childUuid, childEmail, createNew } =
			req.body || {};
		const partnerSecret =
			req.headers["x-partner-key"] || req.body?.partnerSecret;
		const result = await integrationService.connectChildByPartner({
			partnerSecret,
			email,
			playerId,
			displayName,
			childUuid,
			childEmail,
			createNew,
		});
		return res.status(201).json({ success: true, ...result });
	} catch (err) {
		if (err?.needsSelection) {
			return res.status(409).json({
				success: false,
				needsSelection: true,
				children: err.children || [],
				message: err.message,
			});
		}
		return sendError(res, err, "Failed to connect Athena child");
	}
}

/** PUBLIC (partner): remove a per-child link by Family Chores playerId. */
async function disconnectAthenaChild(req, res) {
	try {
		const { email, playerId } = req.body || {};
		const partnerSecret =
			req.headers["x-partner-key"] || req.body?.partnerSecret;
		const result = await integrationService.disconnectChildByPartner({
			partnerSecret,
			email,
			playerId,
		});
		return res.json({ success: true, ...result });
	} catch (err) {
		return sendError(res, err, "Failed to disconnect Athena child");
	}
}

module.exports = {
	getFamilyChoresStatus,
	disconnectFamilyChores,
	disconnectFamilyChoresByPartner,
	connectFamilyChores,
	suggestChores,
	suggestGhostChores,
	rememberFamilyChores,
	listAthenaChildren,
	connectAthenaChild,
	disconnectAthenaChild,
};
