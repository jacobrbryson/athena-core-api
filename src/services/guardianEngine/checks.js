/**
 * The reusable unit of the Guardian Engine: one thing to verify about the
 * house. A protocol is a trigger plus a list of these.
 *
 * Each check says what it looks at, its vocabulary, which value is safe and
 * which is not, how bad "not safe" is, how soon to look again, and how to say
 * it. The vision model only fills in `state` and `confidence` from a fixed
 * vocabulary; everything that decides anything is here, in code.
 *
 * Adding a check for a future protocol (an exterior door, a leak sensor):
 * add an entry, give it an observer in observe.js if it needs a new source,
 * and a test weighted toward the cases where it must NOT say "safe".
 */

const GARAGE = {
	id: "garage_door",
	label: "Garage door",
	source: "camera",
	safe: "closed",
	unsafe: "open",
	vocabulary: ["closed", "open", "partially_open", "unknown"],
	/** Anything not fully closed is open: a door a foot up is not a closed door. */
	normalize: (state) => (state === "partially_open" ? "open" : state),
	severity: () => "urgent",
	recheckMinutes: 15,
	maxRechecks: 8,
	question(subject) {
		return `Is the garage door described as "${subject.name}"${subject.region ? ` (${subject.region})` : ""} fully closed, open, or partially open?
- "closed": the door panel is fully down and meets the ground along its whole width.
- "open": the door is up or the opening is visible.
- "partially_open": the door is down part of the way, with a gap at the bottom you can see.
- "unknown": you cannot see that door clearly enough to tell (dark, glare, blocked, out of frame, blurry).
Set "visible" false if that door is not in the image at all.`;
	},
	alertText(subject, ev, ctx) {
		const lead = ctx.trigger === "schedule" ? "Athena here. It's lights out, but the" : "Athena here. The";
		return `${lead} ${lower(subject.name)} appears to be open. I checked the ${ev.cameraName || "garage"} camera just now (${ctx.clock}). Can someone close it?`;
	},
	resolvedText(subject, ev, ctx) {
		return `The ${lower(subject.name)} is closed now — I checked the ${ev.cameraName || "garage"} camera at ${ctx.clock}.`;
	},
};

const UMBRELLA = {
	id: "patio_umbrella",
	label: "Patio umbrella",
	source: "camera",
	safe: "down",
	unsafe: "up",
	vocabulary: ["down", "up", "unknown"],
	normalize: (state) => state,
	/** Urgent when the weather is close enough that waiting for morning would be too late. */
	severity: (ctx) => (ctx.risk?.urgent ? "urgent" : "advisory"),
	recheckMinutes: 30,
	maxRechecks: 6,
	/** Only under weather risk; the nightly sweep skips it on a calm night. */
	appliesWhen: (ctx) => ctx.risk?.atRisk === true,
	question(subject) {
		return `Is the patio umbrella described as "${subject.name}"${subject.region ? ` (${subject.region})` : ""} open or closed?
- "up": the canopy is opened out.
- "down": the canopy is closed/furled against the pole, or the umbrella has been taken down or laid flat.
- "unknown": you cannot see it clearly enough to tell.
Set "visible" false if no umbrella is in the image at all.`;
	},
	alertText(subject, ev, ctx) {
		// Without a readable forecast she says so rather than inventing a storm.
		if (!ctx.weatherPhrase) return `I couldn't read the forecast just now, and the ${lower(subject.name)} appears to be open. Worth lowering it if wind is coming.`;
		return `There's ${ctx.weatherPhrase}, and the ${lower(subject.name)} still appears to be open. You may want to lower it before the wind picks up.`;
	},
	resolvedText(subject, ev, ctx) {
		return `The ${lower(subject.name)} is down now — I checked the ${ev.cameraName || "backyard"} camera at ${ctx.clock}.`;
	},
};

const CHECKS = { [GARAGE.id]: GARAGE, [UMBRELLA.id]: UMBRELLA };

const REASONS = {
	offline: "the camera isn't responding",
	bridge_unreachable: "the camera bridge at home isn't reachable",
	not_configured: "the camera bridge isn't set up",
	device_unavailable: "the camera isn't responding",
	station_busy: "the camera base station was busy with another camera",
	no_fresh_capability: "that camera can't take a fresh picture on request",
	capture_failed: "the camera didn't return a picture",
	bad_media: "the camera returned an unusable picture",
	stale: "the only picture I have is too old to confirm",
	not_visible: "it isn't visible in the camera's view",
	low_confidence: "the picture wasn't clear enough to tell",
	conflict: "the camera and the sensor disagree",
	vision_unavailable: "I couldn't analyse the picture",
	dispatch_unavailable: "the check didn't run — I couldn't reach the cameras at sweep time",
	no_camera: "no camera is assigned to watch it",
	weather_unknown: "I couldn't read the forecast",
};

const lower = (s) => String(s || "").replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());

/** "I couldn't verify whether the garage door is closed because …" */
function unknownText(check, subject, ev, ctx) {
	const why = REASONS[ev.reason] || "I couldn't get a clear, current look";
	const safeWord = check.safe === "closed" ? "closed" : "down";
	const stale = ev.reason !== "stale" && ctx.lastGoodAt ? ` The last available image is too old to confirm.` : "";
	const tail = check.id === UMBRELLA.id && ctx.weatherPhrase ? ` There's ${ctx.weatherPhrase}.` : "";
	return `I couldn't verify whether the ${lower(subject.name)} is ${safeWord} because ${why}.${stale}${tail}`;
}

function escalationText(check, subject, incident) {
	const what = incident.condition_status === check.unsafe ? `still appears to be ${check.unsafe === "open" ? "open" : "up"}` : "still isn't verified";
	return `Reminder: the ${lower(subject.name)} ${what}, and no one has acknowledged it yet.`;
}

/** Clean what the model returned against the check's vocabulary. Never trusts a state it doesn't know. */
function readModel(check, data) {
	const raw = String(data?.state || "").toLowerCase();
	const state = check.vocabulary.includes(raw) ? check.normalize(raw) : "unknown";
	const confidence = Number(data?.confidence);
	return {
		visible: data?.visible !== false,
		state,
		confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, Math.round(confidence * 1000) / 1000)) : 0,
		reason: typeof data?.reason === "string" ? data.reason.slice(0, 200) : null,
	};
}

module.exports = { CHECKS, GARAGE, UMBRELLA, REASONS, unknownText, escalationText, readModel, lower };
