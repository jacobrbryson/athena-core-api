/**
 * Mission badges (owner, 11-24): the six that exist so far. The five Guardians-
 * app missions are adventure-wide, by mission key; I Spy is Athena's mission,
 * by id, and the first badge she earns herself ("First Sight").
 *
 * `emblem` is the brief for the painted art (scripts/badgeArt.js), which lands
 * in companion/public/assets/badges/<key>.webp. The words a kid reads are
 * `name` and `story`; the art never has text in it.
 */
const BADGES = [
	{
		key: "answered-the-call",
		missionKey: "mission-0-check-in",
		name: "Answered the Call",
		story: "You checked in and joined the Guardian Network.",
		emblem: "seven small glowing lanterns standing in a ring on a hilltop at dusk around a central beacon whose light shoots up into a starry sky, a calm lake below",
	},
	{
		key: "trailblazer",
		missionKey: "mission-1-ratatouille-trail",
		name: "Trailblazer",
		story: "You cracked trail keys and followed the trail to Ratatouille.",
		emblem: "a winding forest trail at twilight marked by small glowing brass keys hanging from the branches, leading to a tiny lit round door at the foot of a huge old tree",
	},
	{
		key: "codebreaker",
		missionKey: "mission-2-convergence",
		name: "Codebreaker",
		story: "Your family's map piece helped decode where the signal pointed.",
		emblem: "four torn pieces of an old parchment map fitting together into one, their joining edges glowing bright cyan, with faint coordinate grid lines and a compass rose",
	},
	{
		key: "signal-keeper",
		missionKey: "mission-2-portico",
		name: "Signal Keeper",
		story: "You answered the Portico Signal.",
		emblem: "an old stone portico archway on a lakeshore at night with a beam of signal light pulsing up from it in glowing rings toward the stars",
	},
	{
		key: "first-watch",
		missionKey: "mission-3-first-watch",
		name: "First Watch",
		story: "You searched the high ground for the founders' lost records.",
		emblem: "a brass lantern standing on a rocky hilltop above a moonlit lake, an old yellowed index card tucked beside it, and the tip of a church steeple just under the still water",
	},
	{
		key: "first-sight",
		missionTitle: "Teach Athena I Spy",
		withAthena: true,
		name: "First Sight",
		story: "Twelve rounds of I Spy with the tablet cameras: the first time Athena saw the world through a Guardian's eyes, and the first badge she ever earned.",
		emblem: "a wide open eye whose pupil is a glowing cyan camera lens, set over a golden sunrise horizon above a lake with a distant castle, with twelve small gold stars evenly spaced around the badge rim",
	},
];

const ART_STYLE =
	"A circular badge for a children's adventure club, centered and filling the square frame, on a plain deep navy background (#04121e) outside the circle. " +
	"Painted digital illustration, rich and glowing, like a fantasy night scene: deep blues and violets, warm sunset gold, luminous cyan highlights. " +
	"The badge has a thick polished metal rim like an enamel pin, with a thin glowing cyan inner ring. " +
	"Absolutely no text, letters, numbers or words anywhere, and no people or faces. Emblem in the middle: ";

const artPath = (key) => `/assets/badges/${key}.webp`;

module.exports = { BADGES, ART_STYLE, artPath };
