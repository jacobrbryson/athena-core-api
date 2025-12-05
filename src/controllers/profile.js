const { RecaptchaEnterpriseServiceClient } = require("@google-cloud/recaptcha-enterprise");
const profileService = require("../services/profile");
const { inviteParentByEmail } = require("../services/parent");
const config = require("../config");
const { publicProfile } = require("../helpers/serialize");

function buildProfileFromJwt(payload = {}) {
	const fullName =
		payload.full_name ||
		payload.name ||
		[payload.given_name, payload.family_name].filter(Boolean).join(" ") ||
		null;

	return {
		email: payload.email || null,
		full_name: fullName,
		picture: payload.picture || null,
	};
}

async function getProfile(req, res) {
	try {
		const { googleId, tokenPayload: payload } = req.user;

		let profile = await profileService.getProfileByGoogleId(googleId);

		if (!profile) {
			const seeded = buildProfileFromJwt(payload);
			profile = await profileService.createProfile(googleId, seeded);
			return res.status(201).json(publicProfile(profile));
		}

		return res.status(200).json(publicProfile(profile));
	} catch (err) {
		console.error("Error fetching profile:", err);
		return res
			.status(500)
			.json({ success: false, message: "Failed to fetch profile" });
	}
}

async function createProfile(req, res) {
	try {
		const { googleId, tokenPayload: payload } = req.user;
		const payloadBody = req.body || {};

		const existing = await profileService.getProfileByGoogleId(googleId);
		if (existing?.profile_editing_locked) {
			return res.status(403).json({
				success: false,
				message:
					"Profile editing has been disabled by your parent or guardian.",
			});
		}
		const profilePayload = {
			...buildProfileFromJwt(payload),
			...payloadBody,
		};

		const profile = existing
			? await profileService.updateProfile(googleId, profilePayload)
			: await profileService.createProfile(googleId, profilePayload);

		return res
			.status(existing ? 200 : 201)
			.json(publicProfile(profile));
	} catch (err) {
		console.error("Error creating profile:", err);

		if (err.message?.includes("No valid profile fields")) {
			return res.status(400).json({
				success: false,
				message: "No valid profile fields provided",
			});
		}

		return res
			.status(500)
			.json({ success: false, message: "Failed to save profile" });
	}
}

async function updateProfile(req, res) {
	try {
		const { googleId, tokenPayload: payload } = req.user;

		const payloadBody = req.body || {};

		const existing = await profileService.getProfileByGoogleId(googleId);
		if (!existing) {
			const profilePayload = {
				...buildProfileFromJwt(payload),
				...payloadBody,
			};
			const profile = await profileService.createProfile(
				googleId,
				profilePayload
			);
			return res.status(201).json(profile);
		}

		if (existing.profile_editing_locked) {
			return res.status(403).json({
				success: false,
				message:
					"Profile editing has been disabled by your parent or guardian.",
			});
		}

		const profilePayload = {
			...buildProfileFromJwt(payload),
			...payloadBody,
		};

		const updated = await profileService.updateProfile(
			googleId,
			profilePayload
		);

		return res.json(publicProfile(updated));
	} catch (err) {
		console.error("Error updating profile:", err);

		if (err.message?.includes("No valid profile fields")) {
			return res.status(400).json({
				success: false,
				message: "No valid profile fields provided",
			});
		}

		return res
			.status(500)
			.json({ success: false, message: "Failed to update profile" });
	}
}

async function verifyRecaptcha(token, action = "invite_parent") {
	if (!token) {
		throw new Error("Missing recaptcha token");
	}

	// If a secret is configured, use the simple siteverify flow first (bypasses Enterprise).
	if (config.RECAPTCHA_SECRET) {
		try {
			const response = await fetch(
				"https://www.google.com/recaptcha/api/siteverify",
				{
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: `secret=${encodeURIComponent(
						config.RECAPTCHA_SECRET
					)}&response=${encodeURIComponent(token)}`,
				}
			);

			const data = await response.json();
			if (!data.success) {
				console.warn("reCAPTCHA verification failed", data);
				throw new Error("Invalid reCAPTCHA");
			}

			return true;
		} catch (err) {
			console.error("Error verifying reCAPTCHA", err);
			throw new Error("Failed to verify reCAPTCHA");
		}
	}

	// Otherwise, attempt Enterprise if project + site key are configured.
	if (config.RECAPTCHA_PROJECT_ID && config.RECAPTCHA_SITE_KEY) {
		try {
			const client = new RecaptchaEnterpriseServiceClient();
			const parent = client.projectPath(config.RECAPTCHA_PROJECT_ID);
			const request = {
				parent,
				assessment: {
					event: {
						token,
						siteKey: config.RECAPTCHA_SITE_KEY,
					},
				},
			};

			const [response] = await client.createAssessment(request);
			const props = response.tokenProperties || {};

			if (!props.valid) {
				throw new Error(
					`Invalid reCAPTCHA token: ${props.invalidReason || "unknown"}`
				);
			}

			if (props.action && props.action !== action) {
				throw new Error(
					`reCAPTCHA action mismatch (expected ${action}, got ${props.action})`
				);
			}

			return true;
		} catch (err) {
			console.error("reCAPTCHA Enterprise verification failed", err);
			throw new Error(
				"Failed to verify reCAPTCHA (Enterprise). Ensure GOOGLE_APPLICATION_CREDENTIALS is set, the API is enabled, and the service account has recaptchaenterprise.assessments.create."
			);
		}
	}

	throw new Error("reCAPTCHA is not configured on the server");
}

async function inviteParent(req, res) {
	try {
		const { googleId } = req.user;

		const body = req.body || {};
		const email = body.email;
		const recaptchaToken = body.recaptcha_token || body.recaptchaToken;

		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (typeof email !== "string" || !emailRegex.test(email.trim())) {
			return res
				.status(400)
				.json({ success: false, message: "Invalid email address" });
		}

		await verifyRecaptcha(recaptchaToken, "invite_parent");

		const result = await inviteParentByEmail(googleId, email);

		return res.status(200).json(result);
	} catch (err) {
		console.error("Error inviting parent:", err);
		const message =
			err.message && err.message.toLowerCase().includes("captcha")
				? err.message
				: "Failed to send parent invite";
		return res.status(500).json({ success: false, message });
	}
}

async function getGuardians(req, res) {
	try {
		const { googleId } = req.user;

		const guardians = await profileService.getGuardiansByGoogleId(googleId);
		return res
			.status(200)
			.json(guardians.map((guardian) => publicProfile(guardian)));
	} catch (err) {
		console.error("Error fetching guardians:", err);
		return res
			.status(500)
			.json({ success: false, message: "Failed to fetch guardians" });
	}
}

module.exports = {
	getProfile,
	createProfile,
	updateProfile,
	inviteParent,
	getGuardians,
};
