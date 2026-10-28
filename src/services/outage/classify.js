/**
 * "Is something down?" — the deterministic half of the outage watch.
 *
 * Pure functions: given what the independent sources say right now, decide
 * whether several of them went quiet together, and word it. No model, no
 * database, no clock of its own.
 *
 * What counts as a source going quiet:
 *   - a Nest thermostat that Google lists as OFFLINE and that went offline in
 *     the last two hours (an old, unrelated offline thermostat is not news);
 *   - the Eufy camera bridge not answering at all (host or tailnet down).
 *     A bridge that answers but isn't "ready" is a different problem (its
 *     Eufy sign-in), reported separately — see bridgeNote().
 *
 * Several = at least two such things, and the Nest ones must have gone offline
 * within WINDOW_MS of each other (a "went offline together" cluster).
 *
 * What it cannot see, and says so: a power cut and a home internet outage look
 * identical from here — both silence the same devices. Detection is by
 * absence, so a check has to run some minutes after the first signal.
 */
const WINDOW_MS = 10 * 60_000;
const RECENT_MS = 2 * 3600_000;
const TEXT_MAX = 500; // athena_nudge.text

const ms = (d) => (d ? new Date(d).getTime() : NaN);

/** Largest group of devices whose offline times all fall inside one WINDOW_MS span. */
function cluster(devices) {
	const timed = devices.filter((d) => Number.isFinite(ms(d.offlineSince))).sort((a, b) => ms(a.offlineSince) - ms(b.offlineSince));
	let best = [];
	for (let i = 0; i < timed.length; i++) {
		const group = timed.filter((d) => ms(d.offlineSince) >= ms(timed[i].offlineSince) && ms(d.offlineSince) - ms(timed[i].offlineSince) <= WINDOW_MS);
		if (group.length > best.length) best = group;
	}
	return best;
}

/**
 * @param {object} p
 * @param {Date} p.now
 * @param {Array<{name:string,label:string,offlineSince:Date|null}>|null} p.nest  OFFLINE thermostats (null = unreadable)
 * @param {{reachable:boolean}|null} p.bridge  null = no bridge in this household
 * @returns {{items:Array,suspected:boolean,nowDark:Array}}
 *   items: what went dark together (for the report); nowDark: everything dark
 *   right now regardless of age (for deciding it's over).
 */
function classify({ now, nest, bridge }) {
	const nowMs = now.getTime();
	const offline = nest || [];
	const recent = offline.filter((d) => Number.isFinite(ms(d.offlineSince)) && nowMs - ms(d.offlineSince) <= RECENT_MS);
	const together = cluster(recent);
	const items = together.map((d) => ({ source: "nest", name: d.name, label: d.label, at: new Date(d.offlineSince).toISOString() }));
	const bridgeDark = Boolean(bridge) && bridge.reachable === false;
	if (bridgeDark) items.push({ source: "camera", name: "camera-bridge", label: "the camera bridge", at: null });
	const nowDark = offline.map((d) => ({ source: "nest", name: d.name, label: d.label }));
	if (bridgeDark) nowDark.push({ source: "camera", name: "camera-bridge", label: "the camera bridge" });
	return { items, suspected: items.length >= 2, nowDark };
}

function listOf(labels) {
	if (labels.length <= 1) return labels[0] || "";
	return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** "2:14 PM" in the household's zone. */
function clock(date, timeZone) {
	return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(date));
}

/** " within 3 minutes" from the timed items, or "" when there is nothing to measure. */
function spread(items) {
	const times = items.filter((i) => i.at).map((i) => ms(i.at));
	if (times.length < 2) return "";
	const minutes = Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 60_000));
	return minutes <= 1 ? " within a minute" : ` within ${minutes} minutes`;
}

/** Required text first, then optional sentences in priority order while they still fit. */
function fit(required, optionals) {
	let text = required;
	for (const part of optionals) {
		if (!part) continue;
		const next = `${text} ${part}`;
		if (next.length <= TEXT_MAX) text = next;
	}
	return text.length <= TEXT_MAX ? text : `${text.slice(0, TEXT_MAX - 1).trimEnd()}…`;
}

/**
 * The one report. Calm and factual: what went quiet and when, what was and
 * wasn't found, what couldn't be checked. Never a guess about cause.
 */
function reportText({ items, openedAt, evidence, timeZone }) {
	const head = `${listOf(items.map((i) => i.label))} went offline${spread(items)}, around ${clock(openedAt, timeZone)}.`;
	const cause = evidence.cause;
	let causeLine;
	if (cause.status === "found") causeLine = `What I found: ${cause.text}`;
	else if (cause.status === "failed") causeLine = "My search for a cause didn't work, so I don't know why.";
	else causeLine = "I searched for a cause and found nothing published yet.";
	const calls = evidence.calls;
	let callLine = null;
	if (calls.error) callLine = "I couldn't read recent 911 calls.";
	else if (calls.plausible.length) {
		const named = calls.plausible.slice(0, 2).map((c) => `${c.what}${c.where ? ` on ${c.where}` : ""}${c.miles != null ? ` (${c.miles} mi)` : ""}`);
		callLine = `A 911 call near home in the last 30 minutes: ${named.join("; ")}.`;
	}
	const nwsLine = evidence.nws.error ? "I couldn't read weather alerts." : evidence.nws.alerts.length ? `The weather service has an active ${evidence.nws.alerts[0].event} for the area.` : null;
	const blind = cause.status === "found" ? null : "From here a power cut and a home internet outage look the same.";
	return fit(head, [causeLine, callLine, nwsLine, blind, "I'll tell you when they're back."]);
}

function recoveryText({ items, stillDark, recoveredAt, exact, timeZone, cause }) {
	const back = items.map((i) => i.label).filter((l) => !stillDark.includes(l));
	const when = clock(recoveredAt, timeZone);
	const verb = back.length > 1 ? "are" : "is";
	const at = exact ? `at ${when}` : `when I checked at ${when}`;
	let head;
	if (!back.length) head = `${listOf(stillDark)} still ${stillDark.length > 1 ? "aren't" : "isn't"} answering as of ${when}.`;
	else if (stillDark.length) head = `${listOf(back)} ${verb} back online (${at}); ${listOf(stillDark)} still ${stillDark.length > 1 ? "aren't" : "isn't"} answering.`;
	else head = `${listOf(back)} ${verb} back online ${at}.`;
	let causeLine;
	if (cause.status === "found") causeLine = `What I found: ${cause.text}`;
	else if (cause.status === "failed") causeLine = "My search for the cause didn't work, so I still don't know why.";
	else causeLine = "I didn't find a published cause.";
	return fit(head, [causeLine]);
}

/** The camera bridge on its own: down, or up but unable to work. */
function bridgeNote({ state, since, lastOkAt, timeZone }) {
	const last = lastOkAt ? ` My last good contact was ${clock(lastOkAt, timeZone)}.` : "";
	if (state === "unreachable") {
		return fit(`The camera bridge hasn't answered since ${clock(since, timeZone)}.${last}`, [
			"Cameras and the nightly sweeps can't see anything until it's back.",
			"A power cut at the bridge's computer, or a lost network or Tailscale connection, is the usual reason.",
		]);
	}
	if (state === "authorization_required") {
		return fit(`The camera bridge is running but needs its Eufy sign-in again (since ${clock(since, timeZone)}).`, ["Cameras can't be read until someone signs in on the bridge computer."]);
	}
	return fit(`The camera bridge is running but not connected to Eufy (${state}) since ${clock(since, timeZone)}.${last}`, ["Cameras can't be read until it reconnects."]);
}

function bridgeBackText({ since, now, timeZone }) {
	return `The camera bridge is answering again as of ${clock(now, timeZone)} (it had been down since ${clock(since, timeZone)}).`;
}

module.exports = { classify, cluster, reportText, recoveryText, bridgeNote, bridgeBackText, listOf, clock, WINDOW_MS, RECENT_MS, TEXT_MAX };
