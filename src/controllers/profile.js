const jwt = require("jsonwebtoken");
const profileService = require("../services/profile");
const config = require("../config");

function decodeAuthToken(req) {
	const authHeader = req.headers.authorization || "";
	if (!authHeader.startsWith("Bearer ")) {
		return { googleId: null, payload: null };
	}

	try {
		const token = authHeader.slice("Bearer ".length);
		const decoded = jwt.verify(token, config.JWT_SECRET);
		const googleId =
			decoded.googleId || decoded.google_id || decoded.sub || null;
		return { googleId, payload: decoded };
	} catch (err) {
		console.warn("Profile controller: Failed to verify JWT", err.message);
		return { googleId: null, payload: null };
	}
}

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
		const { googleId, payload } = decodeAuthToken(req);
		if (!googleId) {
			return res
				.status(401)
				.json({ success: false, message: "Unauthorized" });
		}

		let profile = await profileService.getProfileByGoogleId(googleId);

		if (!profile) {
			const seeded = buildProfileFromJwt(payload);
			profile = await profileService.createProfile(googleId, seeded);
			return res.status(201).json(profile);
		}

		return res.status(200).json(profile);
	} catch (err) {
		console.error("Error fetching profile:", err);
		return res
			.status(500)
			.json({ success: false, message: "Failed to fetch profile" });
	}
}

async function createProfile(req, res) {
	try {
		const { googleId, payload } = decodeAuthToken(req);
		if (!googleId) {
			return res
				.status(401)
				.json({ success: false, message: "Unauthorized" });
		}
		const payloadBody = req.body || {};

		const existing = await profileService.getProfileByGoogleId(googleId);
		const profilePayload = {
			...buildProfileFromJwt(payload),
			...payloadBody,
		};

		const profile = existing
			? await profileService.updateProfile(googleId, profilePayload)
			: await profileService.createProfile(googleId, profilePayload);

		return res.status(existing ? 200 : 201).json(profile);
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
		const { googleId, payload } = decodeAuthToken(req);
		if (!googleId) {
			return res
				.status(401)
				.json({ success: false, message: "Unauthorized" });
		}

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

		const profilePayload = {
			...buildProfileFromJwt(payload),
			...payloadBody,
		};

		const updated = await profileService.updateProfile(
			googleId,
			profilePayload
		);

		return res.json(updated);
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

module.exports = {
	getProfile,
	createProfile,
	updateProfile,
};
