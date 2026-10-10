/**
 * The shape of `needs` in the reply schema (services/needs). Kept apart from
 * needs.js so the prompt builder can name it without loading every connector.
 */
const SOURCE_IDS = ["calendar", "email", "whoop", "heart_rate", "weather", "web"];

/** Calendar range -> days to read. */
const RANGES = {
	today: 1,
	tomorrow: 2,
	this_week: 7,
	next_30_days: 30,
};

const NEEDS_SCHEMA = {
	type: "array",
	items: {
		type: "object",
		properties: {
			source: { type: "string", enum: SOURCE_IDS },
			// No enum here on purpose: strict-schema tiers make optional fields
			// nullable, and a nullable enum without null in it is a schema some
			// of them refuse. needs.clean() checks the value against RANGES.
			range: { type: "string" },
			place: { type: "string" },
			when: { type: "string" },
			query: { type: "string" },
		},
		required: ["source"],
	},
};

module.exports = { SOURCE_IDS, RANGES, NEEDS_SCHEMA };
