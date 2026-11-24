#!/usr/bin/env node
/**
 * Give the approved I Spy mission its new story (owner, 11-24): Athena wants a
 * mission badge of her own and to see the world the way the kids do. Changes
 * only the kid-facing words (plan.story and each kid step's quest), checked by
 * the same rules every story meets. Dry run unless --write.
 */
require("dotenv").config({ quiet: true });
const pool = require("../src/helpers/db");
const story = require("../src/services/guardianMissions/story");
const { QUEST, STORY } = require("./ispyWords");

(async () => {
	const write = process.argv.includes("--write");
	const [[m]] = await pool.query("SELECT id, family_id, plan, phase FROM athena_gm_mission WHERE title = 'Teach Athena I Spy' AND source <> 'legacy' AND approval_state = 'approved' ORDER BY id DESC LIMIT 1");
	if (!m) throw new Error("No approved I Spy mission.");
	if (m.phase === "live") throw new Error("It's already live; its steps were sent with the old words.");
	const plan = typeof m.plan === "string" ? JSON.parse(m.plan) : m.plan;
	const [actors] = await pool.query("SELECT actor_key, kind FROM athena_gm_actor WHERE family_id = ?", [m.family_id]);
	const kinds = Object.fromEntries(actors.map((a) => [a.actor_key, a.kind]));
	const next = { ...plan, story: STORY, steps: plan.steps.map((s) => (kinds[s.actor] === "kid" ? { ...s, quest: QUEST } : s)) };
	const problems = story.validateStory(next, kinds);
	console.log(`mission ${m.id}:`, problems.length ? problems : "words ok");
	if (problems.length) process.exit(1);
	if (write) {
		await pool.query("UPDATE athena_gm_mission SET plan = ? WHERE id = ?", [JSON.stringify(next), m.id]);
		await pool.query("INSERT INTO athena_gm_log (family_id, verb, mission_id, outcome, detail) VALUES (?, 'mission_story_updated', ?, 'ok', ?)", [m.family_id, m.id, JSON.stringify({ by: "owner request 11-24" })]);
		console.log("saved");
	} else console.log("(dry run: add --write)");
	process.exit(0);
})().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
