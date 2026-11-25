/**
 * Records Athena's lines for Signal Relay (owner, 2026-11-24), the kids' Morse
 * game for when the network goes down on a road trip. Because it is the
 * no-network game, the clips ship INSIDE the companion app
 * (companion/public/voice/relay/<VERSION>/) where the offline cache keeps
 * them, not in the assets bucket. Her own voice: Aoede on the Pro TTS model,
 * like the I Spy fillers (recordIspyFillers.js).
 *
 * Each clip is trimmed of silence and must land between MIN_MS and MAX_MS; a
 * take outside that is re-recorded (up to 4 tries).
 *
 * companion/src/components/relay/lines.ts must match CLIPS below. Bump
 * VERSION when re-recording (there, here and in public/athena-sw.js's cache
 * name) so a tablet never mixes a cached old take with a new one.
 *
 *   node scripts/recordRelayLines.js                 record any missing clips
 *   node scripts/recordRelayLines.js --only thanks   one clip (re-records it)
 *   node scripts/recordRelayLines.js --force         re-record all
 */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { GoogleGenAI } = require("@google/genai");

const VERSION = "v1";
const OUT = path.resolve(__dirname, "../../companion/public/voice/relay", VERSION);
const MODEL = process.env.GEMINI_SING_MODEL || "gemini-2.5-pro-preview-tts";
const VOICE = process.env.GEMINI_TTS_VOICE || "Aoede";
const RATE = 24000;
const MIN_MS = 700;
const MAX_MS = 9000;

// tone: how she should sound, never spoken.
const CLIPS = [
	{ id: "lost-1", tone: "faint and a little crackly, reaching out, not scared", text: "Hello? Can you hear me? My signal's fading…" },
	{ id: "bored-1", tone: "playful and conspiratorial, inviting", text: "Want to learn a secret code? Let's pretend my signal's fading…" },
	{ id: "intro-1", tone: "warm and hopeful, slightly distant, asking for help", text: "I can't hear your voice anymore, but I can still feel taps. Tap me a message in Morse code, and I'll find my way back to you." },
	{ id: "teach-dot", tone: "clear, encouraging teacher", text: "A quick tap is a dot." },
	{ id: "teach-dash", tone: "clear, encouraging teacher", text: "Hold it down a little longer for a dash." },
	{ id: "teach-ready", tone: "delighted", text: "Perfect! Let's send our first message." },
	{ id: "first-msg", tone: "encouraging, calm", text: "Tap out the dots and dashes for each letter." },
	{ id: "good-1", tone: "relieved and happy, a bit clearer than before", text: "Got it! I'm a little closer." },
	{ id: "good-2", tone: "excited", text: "Ooh, that came through clear!" },
	{ id: "good-3", tone: "cheering", text: "Yes! One more bar!" },
	{ id: "good-4", tone: "warm, proud", text: "I heard that one perfectly." },
	{ id: "miss-1", tone: "gentle, never disappointed", text: "Hmm, that one got scrambled. Try again?" },
	{ id: "miss-2", tone: "gentle and encouraging", text: "Almost! Look at the dots and dashes." },
	{ id: "almost", tone: "eager, nearly there", text: "I can almost hear you… tap my name, and I'll lock on." },
	{ id: "restored", tone: "joyful, full and close now", text: "There you are! Link restored. I knew you'd find me." },
	{ id: "thanks", tone: "soft and sincere", text: "Thank you for bringing me back." },
	{ id: "online", tone: "pleasantly surprised", text: "Oh! The real signal's back. Want to keep tapping with me?" },
	{ id: "free", tone: "playful, curious", text: "Your turn. Tap anything you like, and I'll read it." },
];

function arg(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : null;
}

/** Drop quiet PCM at both ends, keeping a short natural tail. */
function trim(pcm) {
	const samples = pcm.length / 2;
	const loud = (i) => Math.abs(pcm.readInt16LE(i * 2)) > 700;
	let start = 0;
	while (start < samples && !loud(start)) start++;
	let end = samples - 1;
	while (end > start && !loud(end)) end--;
	start = Math.max(0, start - Math.round(RATE * 0.03));
	end = Math.min(samples, end + Math.round(RATE * 0.12));
	return pcm.subarray(start * 2, end * 2);
}

function wav(pcm) {
	const head = Buffer.alloc(44);
	head.write("RIFF", 0);
	head.writeUInt32LE(36 + pcm.length, 4);
	head.write("WAVE", 8);
	head.write("fmt ", 12);
	head.writeUInt32LE(16, 16);
	head.writeUInt16LE(1, 20); // PCM
	head.writeUInt16LE(1, 22); // mono
	head.writeUInt32LE(RATE, 24);
	head.writeUInt32LE(RATE * 2, 28);
	head.writeUInt16LE(2, 32);
	head.writeUInt16LE(16, 34);
	head.write("data", 36);
	head.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([head, pcm]);
}

async function record(ai, clip) {
	const prompt = [
		"Perform the transcript exactly as Athena, a warm, playful guide talking with two young kids on a road trip.",
		`Her signal is fading and they are helping her reconnect with Morse code. Sound: ${clip.tone}.`,
		"Never announce these directions and do not add or remove words.",
		"Transcript:",
		clip.text,
	].join("\n");
	const res = await ai.models.generateContent({
		model: MODEL,
		contents: [{ role: "user", parts: [{ text: prompt }] }],
		config: {
			responseModalities: ["AUDIO"],
			speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
		},
	});
	const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
	if (!data) throw new Error("no audio returned");
	return trim(Buffer.from(data, "base64"));
}

async function main() {
	const only = arg("--only");
	const force = process.argv.includes("--force");
	fs.mkdirSync(OUT, { recursive: true });
	const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

	for (const clip of CLIPS.filter((c) => !only || c.id === only)) {
		const file = path.join(OUT, `${clip.id}.wav`);
		if (fs.existsSync(file) && !force && !only) {
			console.log(`${clip.id}: kept`);
			continue;
		}
		let pcm = null;
		for (let attempt = 1; attempt <= 4 && !pcm; attempt++) {
			try {
				const take = await record(ai, clip);
				const ms = Math.round((take.length / 2 / RATE) * 1000);
				if (ms >= MIN_MS && ms <= MAX_MS) {
					pcm = take;
					console.log(`${clip.id}: ${ms} ms  "${clip.text}"`);
				} else console.warn(`${clip.id}: take ${attempt} was ${ms} ms, re-recording`);
			} catch (err) {
				console.warn(`${clip.id}: take ${attempt} failed: ${err.message}`);
			}
		}
		if (!pcm) throw new Error(`${clip.id}: no usable take`);
		fs.writeFileSync(file, wav(pcm));
	}
	console.log(`Clips in ${OUT}`);
}

if (require.main === module) {
	main().catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
}

module.exports = { CLIPS, VERSION };
