function omitKeys(obj, keys = []) {
	if (!obj || typeof obj !== "object") return obj;

	const result = {};
	for (const [key, value] of Object.entries(obj)) {
		if (!keys.includes(key)) {
			result[key] = value;
		}
	}
	return result;
}

function publicProfile(profile) {
	return omitKeys(profile, ["id"]);
}

function publicChild(child) {
	return omitKeys(child, [
		// keep id and relationship_id for UI selection
		"parent_profile_id",
		"child_profile_id",
		"deleted_at",
	]);
}

function publicTopic(topic) {
	return omitKeys(topic, ["id", "topic_id", "session_id"]);
}

function publicLearningMoment(moment) {
	return omitKeys(moment, ["id", "topic_id", "session_id"]);
}

module.exports = {
	omitKeys,
	publicProfile,
	publicChild,
	publicTopic,
	publicLearningMoment,
};
