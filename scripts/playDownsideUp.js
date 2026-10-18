#!/usr/bin/env node
/**
 * Prototype: Athena plays a course of Downside-Up (orcwood.com's gravity-flip
 * platformer), one decision at a time.
 *
 *   node scripts/playDownsideUp.js                     # Level 1
 *   node scripts/playDownsideUp.js --level 4 --max-decisions 300
 *   node scripts/playDownsideUp.js --prefer frontier   # skip the local tier
 *
 * The game runs headless in Godot through tools/athena_harness.gd in the game's
 * own project. That harness pauses the real physics between moves, so a model
 * that takes a second to answer still lands jumps a 60 fps game would never
 * wait for. She sees the course as a text map around her, never the code or
 * the level files — she has to read it the way a player reads the screen.
 *
 * Nothing here touches the live game: the harness swaps in FakeServer, so no
 * run reaches the leaderboard. Model calls go through the router (and so
 * through the access check); their telemetry stays in memory because a few
 * hundred game moves in llm_call_log would read as a traffic spike to the
 * nightly review. Each run writes a JSONL log of every decision.
 */
process.env.TZ = process.env.TZ || "UTC";
require("dotenv").config();
process.env.LLM_TELEMETRY_DB = "false";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const router = require("../src/services/llm/router");

const GODOT = process.env.GODOT_BIN || "C:/Users/jacob/Documents/Godot_Editor/Godot_v4.7.2-stable_win64_console.exe";
const PROJECT = process.env.DOWNSIDE_UP_PROJECT || "C:/Users/jacob/Documents/GoDot/downside-up";
const HISTORY = 8;

const RULES = `You are Athena, playing Downside-Up, a 2D gravity-flip platformer. Reach the treasure chest (C).

The map is the course around you, one character per 64px tile, drawn top-to-bottom as on screen:
  @ you   # solid   . empty   ^ spikes   o coin   C chest (the goal)
  P portal: touching it flips gravity to upside down   U portal: flips you back upright
  M movable block   B floor button (land on it from a jump to power a portal)   X unpowered portal
When upright you stand on the # below you. When upside down you stand on the # above you, and "down" is up the screen.

Movement (the real physics, at 60 frames per second):
- Walking tops out at 200 px/s (about 3 tiles a second); holding "run" with a direction doubles that, but only while on the ground.
- A jump is a short hop: about three-quarters of a tile high and 0.6 s in the air — enough to clear one spike or step over a small gap at running speed. Jump only works on the ground.
- "slam" in the air drives you hard toward the ground and stops sideways motion; slamming onto an M pushes it.
- Gaps in a floor drop you to the lane below (or above, upside down). Courses snake between lanes, so the way forward is not always toward the chest.
- Spikes bounce you back and cost time; from Level 4 on they also cost one of three hearts, and losing all three restarts the course.

You cannot walk through spikes in your own row: they throw you backwards. To clear one, be on the ground with it 1-2 tiles ahead, then send jump:true while holding the direction (and run). The jump happens on the first frame of your move.
At running speed you cover about 1 tile every 10 frames, so near hazards hold for 5-10 frames and look again; on open ground hold longer.
If you have bounced off the same thing twice, do something different.

Each turn, choose inputs and how many frames to hold them (1-60).
Reply with JSON only:
{"thought": "<one short sentence>", "hold": ["right"|"left"|"run", ...], "jump": false, "slam": false, "frames": 12, "notes": "<optional: anything you want to remember for the rest of this course>"}`;

function arg(name, fallback) {
	const at = process.argv.indexOf(name);
	return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

function validate(text) {
	let move;
	try {
		move = JSON.parse(text);
	} catch {
		return "not JSON";
	}
	if (!move || typeof move !== "object") return "not an object";
	if (!Array.isArray(move.hold)) return "hold must be an array";
	if (!Number.isInteger(move.frames) || move.frames < 1 || move.frames > 60) return "frames must be 1-60";
	return null;
}

function prompt(obs, history, notes) {
	const recent = history.length
		? history.map((h) => `- t=${h.at}s ${JSON.stringify(h.move)} -> ${h.result}`).join("\n")
		: "- (first move)";
	return `${RULES}

Level ${obs.level}. Time ${obs.game_seconds}s. Deaths ${obs.deaths}.
Gravity: ${obs.gravity}. On ground: ${obs.on_ground}. Velocity: x=${obs.velocity.x}, y=${obs.velocity.y} px/s (+y is down the screen).
You are at tile (${obs.cell.x}, ${obs.cell.y}); the chest is at (${obs.chest.x}, ${obs.chest.y}). Coins: ${obs.coins}.${obs.hearts == null ? "" : ` Hearts: ${obs.hearts}/3.`}
Since your last move: ${obs.events.length ? obs.events.join("; ") : "nothing notable"}.

Map (you are @):
${obs.map}

Your recent moves:
${recent}

Your notes so far: ${notes || "(none)"}`;
}

/** The harness listens once Godot has booted; retry until it does. */
async function connect(port, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await new Promise((resolve, reject) => {
				const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
				socket.once("error", reject);
			});
		} catch (err) {
			if (Date.now() > deadline) throw new Error(`Downside-Up harness never opened port ${port}: ${err.message}`);
			await new Promise((r) => setTimeout(r, 200));
		}
	}
}

async function main() {
	const level = Number(arg("--level", "1"));
	const maxDecisions = Number(arg("--max-decisions", "250"));
	const prefer = arg("--prefer", undefined);
	const logPath = arg("--log", path.join(os.tmpdir(), `downside-up-L${level}-${Date.now()}.jsonl`));
	const log = fs.createWriteStream(logPath);

	const port = Number(arg("--port", "47610"));
	// The game's own print() output is noise here; the harness speaks over TCP.
	const godot = spawn(GODOT, [
		"--headless", "--fixed-fps", "60", "--path", PROJECT,
		"--script", "res://tools/athena_harness.gd", "--", "--level", String(level), "--port", String(port),
	], { stdio: ["ignore", "ignore", "inherit"] });
	const socket = await connect(port);
	const send = (cmd) => socket.write(`${JSON.stringify(cmd)}\n`);
	const lines = readline.createInterface({ input: socket });

	const history = [];
	let notes = "";
	let decisions = 0;
	let pending = null; // the move whose outcome the next observation reports
	let finished = null;

	console.log(`Athena is playing Downside-Up, Level ${level}. Log: ${logPath}`);
	for await (const line of lines) {
		if (!line.startsWith("@@ ")) continue; // the game's own prints
		const obs = JSON.parse(line.slice(3));
		if (obs.type === "finished") {
			finished = obs;
			break;
		}
		if (pending) {
			pending.result = `now at (${obs.cell.x},${obs.cell.y}), ${obs.gravity}, ${obs.on_ground ? "on ground" : "airborne"}` +
				(obs.events.length ? `; ${obs.events.join("; ")}` : "");
			history.push(pending);
			if (history.length > HISTORY) history.shift();
		}
		if (decisions >= maxDecisions) {
			send({ quit: true });
			break;
		}

		const started = Date.now();
		const out = await router.generate({
			task: "json",
			contents: prompt(obs, history, notes),
			json: true,
			validate,
			temperature: 0.4,
			prefer,
		});
		const move = JSON.parse(out.text);
		if (typeof move.notes === "string" && move.notes.trim()) notes = move.notes.trim().slice(0, 600);
		decisions++;
		const command = { hold: move.hold, jump: !!move.jump, slam: !!move.slam, frames: move.frames };
		pending = { at: obs.game_seconds, move: command };
		log.write(`${JSON.stringify({ decision: decisions, obs, move, model: out.model, ms: Date.now() - started })}\n`);
		console.log(`#${decisions} t=${obs.game_seconds}s (${obs.cell.x},${obs.cell.y}) ${obs.gravity} ` +
			`${command.hold.join("+") || "idle"}${command.jump ? " JUMP" : ""}${command.slam ? " SLAM" : ""} x${command.frames}` +
			` — ${move.thought || ""} [${out.model}, ${Date.now() - started}ms]`);
		send(command);
	}

	socket.end();
	log.end();
	if (finished) {
		console.log(`\nFinished Level ${level} in ${finished.game_seconds}s of game time with ` +
			`${finished.coins}/${finished.total_coins} coins, ${finished.flips} gravity flips, ${finished.deaths} deaths, ${decisions} decisions.`);
	} else {
		console.log(`\nStopped after ${decisions} decisions without reaching the chest.`);
	}
	console.log(`Notes she kept: ${notes || "(none)"}`);
	await new Promise((resolve) => godot.on("exit", resolve));
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
