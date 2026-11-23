/**
 * The owner's I Spy mission (2026-11-23, to start Wednesday 11-25): Thomas and
 * Skylar teach Athena to play I Spy with photos on their tablets. Thomas,
 * Skylar and Athena take turns as the spy; 12 finished rounds finish it, and
 * the kids earn the "Taught Athena I Spy" badge.
 *
 * Needs migration 0124_gm_ispy. With --write it adds two capability rows if
 * they're missing (Athena's "Plays I Spy", linked to Perception, and the kids'
 * "Taught Athena I Spy" skill) and saves the mission as an ordinary draft: it
 * still needs an adult to approve it and press Go. Writes nothing without --write.
 *   node scripts/draftIspy.js [--write]
 */
require("dotenv").config();
const { randomUUID } = require("node:crypto");
const pool = require("../src/helpers/db");
const planning = require("../src/services/guardianMissions/planning");

const FAMILY = 1;
const ROUNDS = 12;

const CAPS = [
	{ key: "ispy", kind: "system", name: "Plays I Spy", badge: "🔎", ability: "perception",
		description: "Looks at a photo from a kid's tablet and guesses what they spied, or picks something herself and gives the clue." },
	{ key: "teaches_ispy", kind: "skill", name: "Taught Athena I Spy", badge: "🔎", ability: null,
		description: "Played a full game of I Spy with Athena and taught her when she missed." },
];

const kidStep = (key, actor) => ({
	key, phase: "live", actor, proof: "game", capability: "ispy", dueMinutes: 7 * 24 * 60, predictMinutes: 90,
	place: "Inside the house",
	instruction: `Play I Spy with Athena on ${actor === "thomas" ? "Thomas" : "Skylar"}'s tablet: Base → Play I Spy. Turns go Thomas, Skylar, Athena; the step finishes itself after ${ROUNDS} rounds.`,
	quest: "Athena has never played I Spy, and she wants you to teach her. Take turns: snap a photo, say what you spy, and tell her if she gets it. When it's her turn, she spies and you guess!",
});

const PLAN = {
	title: "Teach Athena I Spy",
	goal: `Thomas and Skylar teach Athena to play I Spy with photos on their tablets, taking turns with her as the spy, for ${ROUNDS} rounds.`,
	reason: "Tests whether Athena can find what a child means in a real photo of the house, with the kids grading her, not her own judgment.",
	purpose: "add",
	capabilities: ["ispy"],
	game: { kind: "ispy", rounds: ROUNDS, players: ["thomas", "skylar", "athena"] },
	steps: [kidStep("thomas_plays", "thomas"), kidStep("skylar_plays", "skylar")],
	story: {
		title: "Teach Athena I Spy",
		premise: "Athena can see through cameras, but she has never played I Spy. She needs two Guardians to teach her how.",
		reveal: `Every round helped Athena learn to find things in real photos of your house. You taught her that, ${ROUNDS} times over.`,
	},
	passCriteria: [
		{ key: "rounds", kind: "all_steps_done", text: `${ROUNDS} rounds of I Spy were played`, capability: "ispy" },
		{ key: "thomas_badge", kind: "person_steps_done", text: "Thomas taught Athena I Spy", actor: "thomas", skill: "teaches_ispy" },
		{ key: "skylar_badge", kind: "person_steps_done", text: "Skylar taught Athena I Spy", actor: "skylar", skill: "teaches_ispy" },
	],
	safety: { where: "Inside the house", supervision: "Ross or another adult is home", offLimits: "Outside, other people's rooms, and anything private" },
};

async function ensureCapabilities() {
	for (const c of CAPS) {
		await pool.query(
			`INSERT IGNORE INTO athena_gm_capability (uuid, family_id, cap_key, kind, name, description, badge, permission, enabled, audience)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'free', 1, 'kids_too')`,
			[randomUUID(), FAMILY, c.key, c.kind, c.name, c.description, c.badge]
		);
		if (c.ability) {
			const [[ability]] = await pool.query("SELECT id FROM athena_gm_ability WHERE ability_key = ?", [c.ability]);
			if (ability) await pool.query("INSERT IGNORE INTO athena_gm_capability_ability (cap_key, ability_id, weight) VALUES (?, ?, 1)", [c.key, ability.id]);
		}
	}
}

(async () => {
	const write = process.argv.includes("--write");
	if (write) await ensureCapabilities();
	const ctx = await planning.gather(FAMILY);
	const review = planning.contextForReview(ctx);
	const keys = write ? review.capabilityKeys : [...new Set([...review.capabilityKeys, "ispy"])];
	const draft = planning.normalize(PLAN, keys);
	const problems = planning.reviewDraft(draft, { ...review, capabilityKeys: keys, skillKeys: [...new Set([...(review.skillKeys || []), "teaches_ispy"])] });
	console.log(draft.title, problems.length ? problems : "ok");
	if (!write) console.log("  (dry run: capabilities assumed; nothing saved)");
	if (write && !problems.length) console.log("  saved", await planning.saveDraft(FAMILY, draft, []));
	process.exit(problems.length ? 1 : 0);
})().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
