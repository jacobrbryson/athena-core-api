const sleepClimate = require("../sleepClimate");
const thermostatSetpoint = require("./thermostatSetpoint");
const projectPace = require("./projectPace");

/**
 * Research: the person's own data, asked one question at a time
 * (docs/capabilities/research.md). Every study answers in the same shape:
 *
 *   status    needs_source | gathering | inconclusive | ready
 *   progress  { have, needed, unit } — how far the sample is toward a readable
 *             finding. Never a percentage of "done": a study keeps refining.
 *   sentence  the finding or the honest "not yet", written by the study
 *   detail    the study's own numbers, for its panel
 *
 * Studies are read-only arithmetic over data Athena already holds, adult-only,
 * and say nothing until their sample is big enough. They never act, never
 * notify and never write; a finding appears here and in conversation only.
 */

const NIGHTS = "nights";
const DAYS = "days";

const STUDIES = [
	{
		id: "sleep-climate",
		title: "Bedroom & sleep",
		question: "What bedroom temperature goes with your best recovery?",
		sources: ["Google Nest", "WHOOP"],
		run: (id, opts) => sleepClimate.analyze(id, opts),
		unit: NIGHTS,
		progress: (r) => ({ have: r.nights ?? 0, needed: r.needed ?? sleepClimate.MIN_NIGHTS }),
		needs: (r) =>
			r.status === "no_device"
				? "Choose which thermostat is in your bedroom (Property → Utilities → Thermostats → Use for sleep)."
				: "Link Google Nest and WHOOP under Connected apps.",
	},
	{
		id: "thermostat-setpoint",
		title: "Setpoint & heating time",
		question: "How many fewer hours does the heat run when the thermostat is set lower?",
		sources: ["Google Nest"],
		run: (id, opts) => thermostatSetpoint.analyze(id, opts),
		unit: DAYS,
		progress: (r) => ({ have: r.have ?? 0, needed: r.needed ?? thermostatSetpoint.MIN_DAYS }),
		needs: (r) => (r.status === "no_device" ? "No thermostat is reporting right now." : "Link Google Nest under Connected apps."),
	},
	{
		id: "project-pace",
		title: "Project pace",
		question: "How fast do your projects actually move, and when would they finish at that pace?",
		sources: ["Projects"],
		run: (id, opts) => projectPace.analyze(id, opts),
		unit: "steps",
		progress: (r) => ({ have: r.have ?? 0, needed: r.needed ?? projectPace.MIN_STEPS }),
		needs: () => "Finish a few project steps and I'll start measuring.",
	},
];

const STATUS = { not_linked: "needs_source", no_device: "needs_source", gathering: "gathering", flat: "inconclusive", ready: "ready" };

/** One study, folded into the common shape. A failing study reports itself unavailable and never takes the others down. */
async function runOne(study, profileId, opts) {
	const base = { id: study.id, title: study.title, question: study.question, sources: study.sources };
	try {
		const r = await study.run(profileId, opts);
		const status = STATUS[r.status] || "gathering";
		if (status === "needs_source") {
			return { ...base, status, progress: { have: 0, needed: study.progress({}).needed, unit: study.unit }, sentence: study.needs(r), detail: null };
		}
		return {
			...base,
			status,
			progress: { ...study.progress(r), unit: study.unit },
			sentence: r.sentence || "",
			confidence: r.confidence || null,
			detail: r,
		};
	} catch (err) {
		console.error("[research] study failed", { id: study.id, code: err?.code || null, message: err?.message });
		return { ...base, status: "unavailable", progress: null, sentence: "This study is unavailable right now.", detail: null };
	}
}

/** Every study for one person, in the registry's order. */
async function list(profileId, opts = {}) {
	return Promise.all(STUDIES.map((s) => runOne(s, profileId, opts)));
}

module.exports = { list, runOne, STUDIES };
