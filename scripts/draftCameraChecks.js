/**
 * The owner's camera checks (2026-11-01): one mission per house camera, where
 * Athena asks an adult to send Thomas to wave and Skylar to give a thumbs up,
 * looks for herself, and greets them through the camera. These are ordinary
 * drafts: each still needs an adult to approve it and press Go.
 *
 * --eric drafts "Meet Uncle Eric" instead (owner 2026-11-01): the one mission
 * that looks for someone outside the family, once an adult confirms he agreed.
 *
 * Checks every plan and writes nothing unless given --write.
 *   node scripts/draftCameraChecks.js [--eric] [--write]
 */
require("dotenv").config();
const planning = require("../src/services/guardianMissions/planning");

const FAMILY = 1;
const CAMERAS = [
	{ camera: "Doorbell", capability: "doorbell_camera", where: "Front porch" },
	{ camera: "Driveway", capability: "view_cameras", where: "Driveway, with no cars moving" },
	{ camera: "Backyard", capability: "view_cameras", where: "Backyard" },
];

function draftFor({ camera, capability, where }) {
	const step = (key, subject, name, gesture) => ({
		key, phase: "live", actor: "ross", subject, camera, gesture, capability, proof: "camera_check", dueMinutes: 30, predictMinutes: 3,
		instruction: `Send ${name} to the ${camera} camera for ${gesture}, then press They're there. Athena looks for herself.`,
	});
	return {
		title: `Can Athena see you? ${camera}`,
		goal: `Show that Athena can recognize Thomas and Skylar on the ${camera} camera, see what each is doing, and speak to them through it.`,
		reason: `Tests the ${camera} camera with what Athena sees herself, not a code or a tap.`,
		purpose: "test",
		capabilities: [capability, "speak_through_camera"],
		steps: [step("thomas", "thomas", "Thomas", "a big wave"), step("skylar", "skylar", "Skylar", "a thumbs up")],
		passCriteria: [
			{ key: "seen", kind: "all_steps_done", text: "Athena saw both kids do what was asked", capability },
			{ key: "unstuck", kind: "nothing_stuck", text: "Nobody got stuck", capability },
		],
		safety: { where, supervision: "Ross is at home and sends them", offLimits: "The street and neighbors' property" },
	};
}

const ERIC = {
	title: "Meet Uncle Eric",
	goal: "Show that Athena can tell Uncle Eric from a stranger on the Doorbell camera, with the kids beside him.",
	reason: "Eric is staying this week and shows up as a stranger. Teaching her his face should stop that, and this shows whether it worked.",
	purpose: "test",
	capabilities: ["doorbell_camera", "speak_through_camera"],
	steps: [
		{ key: "eric_ok", phase: "prep", actor: "ross", proof: "parent_confirm", guestConsent: "Eric", dueMinutes: 1440, predictMinutes: 10,
			instruction: "Ask Eric if Athena may learn his face and say his name on the cameras, and tell him his photos stay until you remove them. Only press It's done if he said yes." },
		{ key: "meet", phase: "live", actor: "ross", subject: "thomas", also: ["skylar"], guest: "Eric", camera: "Doorbell", gesture: "standing together, facing the camera", capability: "doorbell_camera", proof: "camera_check", dueMinutes: 30, predictMinutes: 5,
			instruction: "Send Thomas and Skylar to the Doorbell camera with Eric, all three together facing it, then press They're there. Athena looks for herself." },
	],
	passCriteria: [
		{ key: "seen", kind: "all_steps_done", text: "Athena named Eric and both kids in one frame", capability: "doorbell_camera" },
		{ key: "unstuck", kind: "nothing_stuck", text: "Nobody got stuck", capability: "doorbell_camera" },
	],
	safety: { where: "Front porch", supervision: "Ross is at home, and Eric is with them", offLimits: "The street and neighbors' property" },
};

(async () => {
	const eric = process.argv.includes("--eric");
	const ctx = await planning.gather(FAMILY);
	const review = planning.contextForReview(ctx);
	const write = process.argv.includes("--write");
	let bad = 0;
	for (const raw of eric ? [ERIC] : CAMERAS.map(draftFor)) {
		const draft = planning.normalize(raw, review.capabilityKeys, { allowGuest: eric });
		const problems = planning.reviewDraft(draft, review);
		bad += problems.length;
		console.log(draft.title, problems.length ? problems : "ok");
		if (write && !problems.length) console.log("  saved", await planning.saveDraft(FAMILY, draft, []));
	}
	process.exit(bad ? 1 : 0);
})().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
