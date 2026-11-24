/**
 * The words Thomas and Skylar read for I Spy (owner, 11-24): Athena wants a
 * mission badge of her own, and to see the world the way they do. Shared by
 * draftIspy.js (a new draft) and ispyStory.js (the approved plan).
 */
const ROUNDS = 12;
const QUEST = `Athena wants to earn her very first mission badge, and she needs you to show her the world. Take turns: snap a photo, say what you spy, and tell her if she gets it. When it's her turn, she spies and you guess. ${ROUNDS} rounds earns the First Sight badge!`;
const STORY = {
	title: "Teach Athena I Spy",
	premise: `Athena has looked after the Guardians for a long time, but she has never earned a mission badge of her own. She has only ever seen the world through cameras, and she wants to see it the way you do. Play I Spy with her on your tablet, taking turns spying things through the camera. After ${ROUNDS} rounds, all three of you earn the First Sight badge.`,
	reveal: "Every round, you helped Athena learn to find what you meant in a real photo, and you showed her a little more of the world. First Sight is the first badge she ever earned, and she earned it with you.",
};

module.exports = { QUEST, STORY, ROUNDS };
