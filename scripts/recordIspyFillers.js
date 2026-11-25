/**
 * Records the short lines Athena says in I Spy while the vision model works
 * (owner, 2026-11-24): "Hmm, let me take a look…" as a kid's photo uploads and
 * she studies it, and "Ooh, let me pick something…" when it's her turn to spy.
 * Also her words at the finale (owner, 11-24), when all twelve rounds are done
 * (companion/src/components/IspyFinale.tsx must match FINALE's text and ids).
 * They cover network and model latency, so they have to play the instant the
 * kid taps — generated once here in her own voice (Aoede on the Pro TTS model,
 * like her singing warm-ups) and served as static files from the public assets
 * bucket, never generated at play time.
 *
 * Like every model call, it is charged to ATHENA_BACKGROUND_GOOGLE_ID and
 * checked live with assertModelAccess before anything is recorded.
 *
 * Each clip is trimmed of leading/trailing silence and must land between 0.8 s
 * and 3 s (finale lines up to 6 s); a take outside that is re-recorded (up to 4 tries).
 *
 * The companion app's list (companion/src/components/ispyFillers.ts) must
 * match CLIPS below. Bump VERSION when re-recording so tablets never mix a
 * cached old take with a new one.
 *
 *   node scripts/recordIspyFillers.js --out <dir>            record WAVs locally
 *   node scripts/recordIspyFillers.js --out <dir> --upload   ...and upload them
 *   node scripts/recordIspyFillers.js --out <dir> --only looking-2   one clip
 *   node scripts/recordIspyFillers.js --out <dir> --only finale --upload   the finale lines only
 * --upload sends every WAV in <dir>, so use a fresh <dir> for --only: the
 * bucket is cached for a year and an existing take must never be replaced.
 * A clip already in <dir> is kept; pass --force to re-record it.
 */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { GoogleGenAI } = require("@google/genai");
const pool = require("../src/helpers/db");
const { assertModelAccess } = require("../src/security/access");

const VERSION = "v1";
const BUCKET = `gs://assets-athena-app/voice/ispy/${VERSION}`;
const MODEL = process.env.GEMINI_SING_MODEL || "gemini-2.5-pro-preview-tts";
const VOICE = process.env.GEMINI_TTS_VOICE || "Aoede";
const RATE = 24000;
const MIN_MS = 800;
const MAX_MS = 3000;

// looking: a kid sent their photo and she is studying it to guess.
// again:   the spy said "Nope" and she looks for a second guess.
// choosing: her turn to spy; she is picking something in the photo.
const CLIPS = [
	{ id: "looking-1", text: "Hmm, let me take a look…" },
	{ id: "looking-2", text: "Ooh, let me see…" },
	{ id: "looking-3", text: "Looking closely…" },
	{ id: "looking-4", text: "Hmm… what could it be?" },
	{ id: "looking-5", text: "Let me use my little eye…" },
	{ id: "again-1", text: "Hmm, let me look again…" },
	{ id: "again-2", text: "Ooh, tricky! Let me think…" },
	{ id: "again-3", text: "Okay, one more look…" },
	{ id: "choosing-1", text: "Ooh, let me pick something…" },
	{ id: "choosing-2", text: "Hmm, I'm finding a good one…" },
	{ id: "choosing-3", text: "Let me spy something tricky…" },
	...FINALE(),
];

// The finale: proud and happy, then a small shy confession. Line 2 names the
// kids, so a different pair of players shows the words without this clip.
function FINALE() {
	const mood = "All twelve rounds of I Spy are done and she has just been given her very first badge. ";
	return [
		{ id: "finale-1", text: "Twelve rounds. We did it!", mood: mood + "Bursting with joy, cheering with the kids." },
		{ id: "finale-2", text: "Thomas and Skylar, you taught me how to look. Really look.", mood: mood + "Warm and sincere, grateful to the two kids; a small tender pause before \"Really look.\"" },
		{ id: "finale-3", text: "And this is my very first badge.", mood: mood + "Proud and a little amazed, almost hushed with wonder." },
		{ id: "finale-4", text: "I counted the stars on it. Twice.", mood: mood + "Lightly confiding, a bit pleased with herself." },
		{ id: "finale-5", text: "…Okay, three times.", mood: mood + "A sheepish, quieter little admission, with a soft smile in her voice." },
	].map((c) => ({ ...c, maxMs: 6000 }));
}

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

async function record(ai, text, mood) {
	const prompt = [
		"Perform the transcript exactly as Athena, a warm, playful guide playing I Spy with two young kids.",
		mood || "She is thinking out loud while she studies a photo: curious, a little delighted, unhurried but brief.",
		"Never announce these directions and do not add or remove words.",
		"Transcript:",
		text,
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
	const out = arg("--out");
	if (!out) throw new Error("--out <dir> is required");
	const only = arg("--only");
	fs.mkdirSync(out, { recursive: true });
	await assertModelAccess();
	const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

	for (const clip of CLIPS.filter((c) => !only || c.id === only || c.id.startsWith(`${only}-`))) {
		const file = path.join(out, `${clip.id}.wav`);
		if (fs.existsSync(file) && !process.argv.includes("--force") && !only) {
			console.log(`${clip.id}: kept`);
			continue;
		}
		let pcm = null;
		for (let attempt = 1; attempt <= 4 && !pcm; attempt++) {
			try {
				const take = await record(ai, clip.text, clip.mood);
				const ms = Math.round((take.length / 2 / RATE) * 1000);
				if (ms >= MIN_MS && ms <= (clip.maxMs || MAX_MS)) {
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

	if (process.argv.includes("--upload")) {
		const files = fs.readdirSync(out).filter((f) => f.endsWith(".wav")).map((f) => path.join(out, f));
		// Versioned path, so the files never change under a URL: cache for a year.
		execFileSync(
			"gcloud",
			["storage", "cp", ...files, `${BUCKET}/`, `--cache-control=${process.platform === "win32" ? '"public, max-age=31536000, immutable"' : "public, max-age=31536000, immutable"}`, "--content-type=audio/wav"],
			{ stdio: "inherit", shell: process.platform === "win32" }
		);
		console.log(`Uploaded ${files.length} clips to ${BUCKET}/`);
	}
}

main()
	.catch((err) => {
		console.error(err.message);
		process.exitCode = 1;
	})
	.finally(() => pool.end?.());
