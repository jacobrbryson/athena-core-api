/**
 * The Guardian quest around a mission (owner 2026-10-31). A mission is a test of
 * Athena; a kid should meet it as a quest. Each plan with a kid in it carries a
 * second set of words, inside the plan so approval locks them with it:
 *
 *   plan.story         { title, premise, reveal }
 *   plan.steps[].quest what a kid reads instead of the real instruction
 *
 * A parent reviews both side by side. Kid-facing surfaces read only these words,
 * and everything graded or checked still reads the real instruction, so a good
 * story can't change a score. The story hides what's being tested, never the
 * real world: the place and safety rules reach a kid in plain words, and `reveal`
 * tells them afterwards what they helped with, because they agreed to help train
 * her and shouldn't only find that out by accident.
 *
 * What a model writes is untrusted, so the checks here are code. They can't prove
 * a quest asks for the same thing as its instruction; the parent reading the two
 * together is what covers that.
 */
const text = (v, max) => String(v ?? "").trim().slice(0, max);

const WORLD = `The Guardians are kids in the Guardian Network, a real-world game they know is a game. The Network was founded in 1963 by seven children from a valley about to be flooded to make Lake Norman. The bargain with you is "You find. I read." Write side quests for the Network, using things like signals, maps, watch posts and field reports. Don't invent or reveal anything about the founders, the old records or the mysteries the Guardians have already solved.`;

const STORY_SCHEMA = {
	type: "object",
	properties: { title: { type: "string" }, premise: { type: "string" }, reveal: { type: "string" } },
	required: ["title", "premise", "reveal"],
};

// A straight apostrophe first, so "don’t" matches the same as "don't".
const flat = (v) => String(v || "").replace(/[‘’]/g, "'");

const GIVES_IT_AWAY = /\b(tests?|testing|tested|train|trains|training|trained|capabilit(y|ies)|scores?|scoring|grades?|graded|grading|pass criteria|experiments?|calibrat\w*|notifications?)\b/i;
const CUTS_OUT_ADULTS = /don't tell|do not tell|not tell (your|any)|keep (this|it) (a )?secret|keep (this|it) quiet|secret from|hide (this|it) from|without (telling|asking)|don't let \w+ (know|see)|\bsneak\w*/i;
const GOES_TOO_FAR = /\balone\b|by yourself|on your own|\bat night\b|after dark|\b911\b|\bpolice\b|emergenc|in danger|\bkidnap|\bor else\b/i;

/** Pure: why words can't go in front of a kid, as a phrase; null when they can. */
function kidWordsProblem(words) {
	const value = flat(words);
	if (GIVES_IT_AWAY.test(value)) return "gives away the test";
	if (CUTS_OUT_ADULTS.test(value)) return "cuts adults out";
	if (GOES_TOO_FAR.test(value)) return "pushes past a safety limit";
	return null;
}

/** Pure: only the fields a draft may set. */
function normalizeStory(raw) {
	if (!raw || typeof raw !== "object") return null;
	return { title: text(raw.title, 120), premise: text(raw.premise, 1000), reveal: text(raw.reveal, 1000) };
}

/** Pure: what's wrong with a plan's kid-facing words, as sentences. kinds maps a plan's actor keys to kid or parent. */
function validateStory(plan, kinds = {}) {
	const kidSteps = (plan?.steps || []).filter((s) => kinds[s?.actor] === "kid");
	if (!kidSteps.length) return [];
	const story = plan?.story;
	if (!story?.title || !story?.premise) return ["It has no quest story for the kids. Ask Athena to revise it."];
	const problems = [];
	const check = (name, words) => {
		const problem = kidWordsProblem(words);
		if (problem) problems.push(`${name} ${problem}.`);
	};
	check("The quest title", story.title);
	check("The quest story", story.premise);
	for (const s of kidSteps) {
		if (text(s?.quest, 1000).length < 10) problems.push(`${s?.key || "A step"}: it has no quest wording for the kids.`);
		else check(`${s.key}: its quest wording`, s.quest);
	}
	if (!/practic|learn|help|train/i.test(flat(story.reveal))) problems.push("It doesn't plan to tell the kids afterwards what they helped with.");
	if (CUTS_OUT_ADULTS.test(flat(story.reveal))) problems.push("The ending cuts adults out.");
	return problems;
}

/** Pure: the words a kid reads for this step, or null when the step has no quest. */
function questFor(plan, planKey) {
	return (plan?.steps || []).find((s) => s.key === planKey)?.quest || null;
}

/** Pure: a mission as a kid meets it. Never the real title or goal when there's a story. */
function forKid(plan, { planKey, title, instruction }) {
	return {
		mission: plan?.story?.title || title,
		premise: plan?.story?.premise || null,
		instruction: questFor(plan, planKey) || instruction,
		safety: plan?.safety || null,
	};
}

module.exports = { WORLD, STORY_SCHEMA, kidWordsProblem, normalizeStory, validateStory, questFor, forKid };
