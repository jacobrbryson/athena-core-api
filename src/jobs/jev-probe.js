/**
 * Probe Jev with real phrasings and print what it guesses, and how fast.
 *
 *   node src/jobs/jev-probe.js                 # the built-in phrasings
 *   node src/jobs/jev-probe.js "am I free at 3?"   # your own
 *
 * Every source is offered (as if all were connected), so no account is read —
 * only the phrasings leave this machine. The call still goes through
 * llm.decide and its live access check, charged to ATHENA_BACKGROUND_GOOGLE_ID.
 * DB telemetry is off: a probe is not traffic.
 */
process.env.LLM_TELEMETRY_DB = "false";
require("dotenv").config();

const intent = require("../services/toolIntent");

const PHRASINGS = [
	// [message, sources we'd expect to be fetched]
	["Do I have anything going on tonight?", ["calendar"]],
	["What am I doing tomorrow?", ["calendar"]],
	["Am I free at three?", ["calendar"]],
	["Any plans this weekend?", ["calendar"]],
	["How did I sleep?", ["whoop"]],
	["Should I push hard on my ride today or take it easy?", ["whoop"]],
	["What's my heart rate doing right now?", ["heart_rate"]],
	["Was that ride too hard? Check my heart rate too.", ["whoop", "heart_rate"]],
	["Did anyone email me about the soccer game?", ["email"]],
	["Tell me a story about dragons", []],
	["What should we have for dinner?", []],
];

async function main() {
	const custom = process.argv.slice(2);
	const cases = custom.length ? custom.map((m) => [m, null]) : PHRASINGS;
	const latencies = [];
	let hits = 0;

	for (const [message, expected] of cases) {
		const started = Date.now();
		const g = await intent.guess(message, { sources: intent.SOURCES });
		const wall = Date.now() - started;
		latencies.push(wall);
		if (!g) {
			console.log(`✗ ${message}\n    no guess (see warning above)\n`);
			continue;
		}
		const ok = expected && [...g.fetch].sort().join() === [...expected].sort().join();
		if (ok) hits++;
		const scores = Object.entries(g.scores)
			.map(([k, v]) => `${k} ${v.toFixed(2)}`)
			.join(", ");
		console.log(
			`${expected ? (ok ? "✓" : "✗") : "·"} ${message}\n` +
				`    fetch [${g.fetch.join(", ")}]${expected ? `  expected [${expected.join(", ")}]` : ""}  window ${g.window}\n` +
				`    say   ${g.filler ? `"${g.filler.text}"` : "(nothing)"}\n` +
				`    ${scores}\n    ${wall} ms wall, ${g.latencyMs} ms Jev, ${g.model}\n`
		);
	}

	latencies.sort((a, b) => a - b);
	const median = latencies[Math.floor(latencies.length / 2)];
	if (!custom.length) console.log(`${hits}/${cases.length} matched expectations.`);
	console.log(`Latency: median ${median} ms, max ${latencies[latencies.length - 1]} ms (from this machine, not Cloud Run).`);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
