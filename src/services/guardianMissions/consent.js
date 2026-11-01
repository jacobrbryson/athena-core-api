/**
 * The opt-in to helping train Athena (migration 0109, owner 2026-10-31).
 *
 * She may not contact a Guardian or parent on a mission unless they agreed, and
 * the record keeps exactly which words they agreed to. An adult agrees for
 * themselves, and that includes a Guardian who has grown up. A minor's parent
 * agrees for them (owner 2026-11-01), and either one leaving ends it at once:
 * a minor who stopped stays out until they say yes again, whatever a parent
 * decides. Agreeing to old terms doesn't count once new ones publish.
 * A database failure counts as no agreement.
 *
 * Safety alerts don't come through here. Those run on their own rules, and
 * people must keep getting a freeze warning whatever they decided about
 * missions.
 *
 * Chat is enforced separately by chatMayProceed, behind the owner's switch, so
 * that turning it on is a decision made once agreements are collected rather
 * than a side effect of deploying this. Mission contact is always enforced.
 */
const { randomUUID } = require("node:crypto");
const pool = require("../../helpers/db");
const settings = require("./settings");
const voiceprints = require("./voiceprints");

/** All anyone who hasn't agreed gets back. Fixed, so no model is involved. */
const FIXED_REPLY = "I can't talk with you here until you've agreed to help train me. Open the agreement in the app to read it and choose. Leaving it is fine, and safety alerts still reach your family.";

const METHODS = new Set(["app_prompt", "settings", "guardians_app"]);

function failure(message, status = 400) {
	return Object.assign(new Error(message), { status });
}

/** The newest terms for each audience. */
async function currentTerms() {
	const [rows] = await pool.query(
		`SELECT t.id, t.version, t.audience, t.title, t.body, t.body_sha256 FROM athena_gm_consent_terms t
		 JOIN (SELECT audience, MAX(version) version FROM athena_gm_consent_terms GROUP BY audience) newest
		   ON newest.audience = t.audience AND newest.version = t.version`
	);
	return Object.fromEntries(rows.map((r) => [r.audience, r]));
}

/** A Guardian's kind is "kid" whatever their age; only a minor has a parent decide for them. */
const isMinor = (person) => person?.kind === "kid" && !person?.is_adult;

/** Which agreements this person needs, as [role, audience]. */
function requirementsFor(person) {
	return isMinor(person) ? [["parent", "parent_for_child"]] : [["self", "adult"]];
}

/** Which roles can decide for this person, needed or not. A minor can always stop, and come back. */
function rolesFor(person) {
	return isMinor(person) ? [...requirementsFor(person), ["self", "child"]] : requirementsFor(person);
}

/**
 * Pure: where a person stands, from their events oldest first. `missing` lists
 * the roles still needed; only an agreement to the current words counts.
 */
function standing({ kind, is_adult = 0, events = [], terms = {} }) {
	const person = { kind, is_adult };
	const missing = [];
	let withdrawn = false;
	let outdated = false;
	if (isMinor(person) && [...events].reverse().find((e) => e.role === "self")?.action === "withdraw") {
		missing.push("self");
		withdrawn = true;
	}
	for (const [role, audience] of requirementsFor(person)) {
		const current = terms[audience];
		const last = [...events].reverse().find((e) => e.role === role);
		if (current && last?.action === "agree" && Number(last.terms_id) === Number(current.id)) continue;
		missing.push(role);
		if (last?.action === "withdraw") withdrawn = true;
		else if (last?.action === "agree") outdated = true;
	}
	if (!missing.length) return { allowed: true, status: "agreed", missing, reason: null };
	if (withdrawn) return { allowed: false, status: "withdrawn", missing, reason: "they have left the training program" };
	if (outdated) return { allowed: false, status: "needs_new_agreement", missing, reason: "the agreement has changed and they haven't agreed to the new one" };
	return { allowed: false, status: "needs_agreement", missing, reason: "they haven't agreed to help train Athena" };
}

/** Pure: why someone isn't in yet, for an adult to act on. */
function blockedReason(actor, state) {
	const name = actor.display_name;
	if (state?.status === "withdrawn") return `${name} has left the training program.`;
	if (!isMinor(actor)) return state?.status === "needs_new_agreement" ? `${name} needs to agree to the new wording.` : `${name} hasn't agreed to help train Athena.`;
	if (state?.status === "needs_new_agreement") return `${name}'s agreement has new wording. A parent needs to agree again under Field Kit.`;
	return `A parent needs to agree for ${name} under Field Kit.`;
}

const closed = (reason) => ({ allowed: false, status: "unknown", missing: [], reason });

/** One person's standing. Fails closed. */
async function standingFor(actor) {
	try {
		const [terms, [events]] = await Promise.all([
			currentTerms(),
			pool.query("SELECT role, action, terms_id FROM athena_gm_consent_event WHERE subject_actor_id = ? ORDER BY id", [actor.id]),
		]);
		return standing({ kind: actor.kind, is_adult: actor.is_adult, events, terms });
	} catch (err) {
		console.warn("[guardian missions] consent unreadable:", err.message);
		return closed("the agreement couldn't be checked");
	}
}

/** Everyone in a family's standing, keyed by actor id. */
async function standingsFor(familyId, actors) {
	const [terms, [events]] = await Promise.all([
		currentTerms(),
		pool.query("SELECT subject_actor_id, role, action, terms_id FROM athena_gm_consent_event WHERE family_id = ? ORDER BY id", [familyId]),
	]);
	const out = {};
	for (const actor of actors) {
		out[actor.id] = standing({ kind: actor.kind, is_adult: actor.is_adult, terms, events: events.filter((e) => Number(e.subject_actor_id) === Number(actor.id)) });
	}
	return out;
}

/** What `decider` may decide for `subject`: their own, or their own family's child. */
function roleFor(decider, subject) {
	if (Number(decider.id) === Number(subject.id)) return "self";
	const family = Number(decider.family_id) === Number(subject.family_id);
	if (family && decider.kind === "parent" && isMinor(subject)) return "parent";
	throw failure("You can't decide that for this person.", 403);
}

async function insertEvent(subject, decider, role, action, term, method) {
	if (!METHODS.has(method)) throw failure("Unknown method.");
	await pool.query(
		`INSERT INTO athena_gm_consent_event (uuid, family_id, subject_actor_id, decided_by_actor_id, role, action, terms_id, terms_sha256, method)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[randomUUID(), subject.family_id, subject.id, decider.id, role, action, term.id, term.body_sha256, method]
	);
}

/**
 * Record an agreement. `termsId` is what the person was shown: if newer terms
 * published while they read, this refuses rather than record words they never
 * saw.
 */
async function agree({ subject, decider, termsId, method }) {
	const role = roleFor(decider, subject);
	const needed = rolesFor(subject).find(([r]) => r === role);
	if (!needed) throw failure("That agreement isn't needed.");
	const term = (await currentTerms())[needed[1]];
	if (!term || Number(term.id) !== Number(termsId)) throw failure("The agreement has changed. Please read the new one.", 409);
	await insertEvent(subject, decider, role, "agree", term, method);
	return standingFor(subject);
}

/**
 * Leave. Takes effect now: the event first, so nothing can be sent after this
 * returns, then anything waiting to go to them is cancelled and any voiceprint
 * deleted. A pause or mute holds an ask; leaving is the one thing that ends it.
 */
async function withdraw({ subject, decider, method }) {
	const role = roleFor(decider, subject);
	const needed = rolesFor(subject).find(([r]) => r === role);
	if (!needed) throw failure("That agreement isn't needed.");
	const term = (await currentTerms())[needed[1]];
	if (!term) throw failure("There is no agreement to leave.", 409);
	await insertEvent(subject, decider, role, "withdraw", term, method);
	await pool.query(
		"UPDATE athena_gm_mission_step SET status = 'declined', result_note = 'They left the training program.' WHERE assigned_actor_id = ? AND status IN ('ready','waiting_parent','waiting_kids','in_progress')",
		[subject.id]
	);
	await voiceprints.forgetVoiceprints(subject.family_id, subject.id);
	return standingFor(subject);
}

/** The Guardians app login's actor, or null when the login isn't one yet. */
async function actorForGuardian(guardianId) {
	if (!guardianId) return null;
	const [rows] = await pool.query(
		"SELECT a.* FROM athena_gm_actor a JOIN guardian_credential g ON g.id = a.guardian_credential_id WHERE g.guardian_id = ? LIMIT 1",
		[guardianId]
	);
	return rows[0] || null;
}

async function actorForProfile(profileId) {
	if (!profileId) return null;
	const [rows] = await pool.query("SELECT * FROM athena_gm_actor WHERE profile_id = ? AND kind IN ('parent','kid') ORDER BY id LIMIT 1", [profileId]);
	return rows[0] || null;
}

const enforced = () => process.env.GM_CONSENT_ENFORCED === "on";

/**
 * May this chat turn reach her? A Guardians login with no agreement gets
 * FIXED_REPLY; so does a parent actor without one. Adults outside the Guardians
 * are unaffected: the access checks already decide who she talks to. Fails
 * closed for anyone it covers.
 */
async function chatMayProceed({ guardianId = null, profileId = null }) {
	if (!guardianId && !profileId) return { allowed: true };
	if (!(await settings.isOn("chat_consent"))) return { allowed: true };
	try {
		const actor = guardianId ? await actorForGuardian(guardianId) : await actorForProfile(profileId);
		if (!actor) return guardianId ? { allowed: false, reply: FIXED_REPLY } : { allowed: true };
		const state = await standingFor(actor);
		return state.allowed ? { allowed: true } : { allowed: false, reply: FIXED_REPLY };
	} catch (err) {
		console.warn("[guardian missions] chat consent unreadable:", err.message);
		return { allowed: false, reply: FIXED_REPLY };
	}
}

module.exports = { FIXED_REPLY, currentTerms, isMinor, blockedReason, requirementsFor, rolesFor, standing, standingFor, standingsFor, roleFor, agree, withdraw, actorForGuardian, actorForProfile, chatMayProceed };
