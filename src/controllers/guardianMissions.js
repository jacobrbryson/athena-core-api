const { resolveActor, requireAdultActor } = require('../helpers/actor');
const missions = require('../services/guardianMissions');
const consent = require('../services/guardianMissions/consent');
const { decodeGuardianFromRequest } = require('../helpers/guardianToken');
const scout = require('../services/guardianMissions/scout');
const house = require('../services/guardianMissions/house');
const runner = require('../services/guardianMissions/runner');
const proof = require('../services/guardianMissions/proof');
const debrief = require('../services/guardianMissions/debrief');
const planning = require('../services/guardianMissions/planning');
const templates = require('../services/guardianMissions/templates');
const dispatch = require('../services/guardianEngine/dispatch');
const actions = require('../services/actions');
const push = require('../services/push');
const llm = require('../services/llm');

/**
 * Companion → Guardians (services/guardianMissions, migration 0103).
 *
 * The page is parent-only: a signed-in adult who is a parent actor
 * (athena_gm_actor kind 'parent'). Everything is scoped to that actor's
 * family; no route takes a family, profile or recipient from the body that it
 * does not look up inside that family.
 *
 * Two routes also accept the Android app's device token, because a phone
 * speaks for itself: the scouting photo upload and a notification button's
 * reply. They resolve the device's profile to its own actor in the same way.
 */
missions.setDeliverer(scout.deliverer(push));
missions.setRunner({
  onApproved: (familyId, mission) => runner.onApproved(familyId, mission, scout.deliverer(push)),
  advance: (familyId, missionId) => runner.advance(familyId, missionId, scout.deliverer(push)),
  stepDone: (familyId, step) => runner.stepDone(familyId, step, scout.deliverer(push)),
  preflightFor: runner.preflightFor,
});

const asParent = (fn) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const who = await requireAdultActor(req, res);
  if (!who) return;
  const parent = await missions.parentActor(who.profileId).catch(() => null);
  if (!parent) return res.status(403).json({ success: false, message: 'Guardians is for parents.' });
  try {
    return await fn(req, res, { profileId: who.profileId, familyId: Number(parent.family_id), actor: parent });
  } catch (err) {
    return answerError(res, err);
  }
};

/** Any household member's own actor (parent or kid), by app session or device token. */
const asMember = (fn) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let who;
  try {
    who = await resolveActor(req);
  } catch {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const [rows] = await require('../helpers/db').query('SELECT * FROM athena_gm_actor WHERE profile_id = ? AND kind IN (\'parent\',\'kid\') ORDER BY id LIMIT 1', [who.profileId]);
    if (!rows[0]) return res.status(403).json({ success: false, message: 'Not part of Guardians.' });
    return await fn(req, res, { profileId: who.profileId, familyId: Number(rows[0].family_id), actor: rows[0] });
  } catch (err) {
    return answerError(res, err);
  }
};

function answerError(res, err) {
  if (err?.status && err.status < 500) return res.status(err.status).json({ success: false, message: err.message });
  console.warn('[guardian missions] request failed:', err?.message || err);
  return res.status(503).json({ success: false, message: 'Guardians is unavailable right now.' });
}

/**
 * A kid's own side, from their Guardians app session. The token is verified
 * here; the login decides whose agreement this is, never the body.
 */
const asGuardian = (fn) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const guardian = decodeGuardianFromRequest(req);
  if (!guardian?.guardian_id) return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    const actor = await consent.actorForGuardian(guardian.guardian_id);
    return await fn(req, res, { actor });
  } catch (err) {
    return answerError(res, err);
  }
};

// Opening the page also sends any ask a lapsed "quiet until" was holding.
// Interim: a Cloud Task at quiet_until is the proper wake-up (not built yet).
const overview = asParent(async (req, res, { familyId }) => {
  await missions.flushHeld(familyId).catch((err) => console.warn('[guardian missions] flush failed:', err.message));
  return res.json(await missions.overview(familyId));
});

const saveControl = asParent(async (req, res, { familyId, profileId }) => {
  const b = req.body || {};
  await missions.setControl(familyId, profileId, { mode: b.mode, quietUntil: b.quietUntil, killSwitch: b.killSwitch, monthlyBudget: b.monthlyBudget, stopWord: b.stopWord });
  return res.json(await missions.overview(familyId));
});

const saveCapability = asParent(async (req, res, { familyId, profileId }) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ success: false, message: 'enabled must be true or false.' });
  await missions.setCapabilityEnabled(familyId, profileId, req.params.uuid, req.body.enabled);
  return res.json(await missions.overview(familyId));
});

const saveRecipient = asParent(async (req, res, { familyId, profileId }) => {
  await missions.setActorMute(familyId, profileId, req.params.uuid, { muted: Boolean(req.body?.muted), mutedUntil: req.body?.mutedUntil || null });
  return res.json(await missions.overview(familyId));
});

const saveSkill = asParent(async (req, res, { familyId, profileId }) => {
  await missions.setSkill(familyId, profileId, req.params.uuid, req.body?.capability, req.body?.level);
  return res.json(await missions.overview(familyId));
});

/** One approval of the plan, recorded in the action layer as the person's own click. */
const approve = asParent(async (req, res, { familyId, profileId }) => {
  await actions.perform(profileId, 'approve_guardian_mission', { mission: req.params.uuid });
  return res.json(await missions.overview(familyId));
});

/** Any adult in the family: "we're ready, start now". Preflight runs here, not in the browser. */
const go = asParent(async (req, res, { familyId, actor }) => {
  await runner.go(familyId, req.params.uuid, { by: actor, supervisorUuid: req.body?.supervisor, deliver: scout.deliverer(push) });
  return res.json(await missions.overview(familyId));
});

/** Planning mode: her self-evaluation, the drafts waiting, and what she wishes she had. */
const planningOverview = asParent(async (req, res, { familyId }) => res.json(await planning.workspace(familyId)));

/** Ask her for drafts, with an optional note. This costs a model call; nothing is contacted. */
const draft = asParent(async (req, res, { familyId }) => {
  const out = await planning.draftPlans(familyId, { llm, note: req.body?.note || null });
  return res.json({ ...out, workspace: await planning.workspace(familyId) });
});

const revise = asParent(async (req, res, { familyId, actor }) => {
  await planning.revise(familyId, req.params.uuid, { llm, note: req.body?.note, by: actor });
  return res.json(await planning.workspace(familyId));
});

const decideWish = asParent(async (req, res, { familyId, actor }) => {
  await planning.decideWish(familyId, req.params.uuid, req.body?.status, actor);
  return res.json(await planning.workspace(familyId));
});

/** Zones and templates. Creating a template is the owner's own recorded click. */
const handoff = asParent(async (req, res, { familyId, actor }) => res.json(await templates.overview(familyId, actor)));

const addZone = asParent(async (req, res, { familyId, actor }) => {
  await templates.createZone(familyId, req.body, actor);
  return res.json(await templates.overview(familyId, actor));
});

const retireZone = asParent(async (req, res, { familyId, actor }) => {
  await templates.retireZone(familyId, req.params.uuid, actor);
  return res.json(await templates.overview(familyId, actor));
});

const addTemplate = asParent(async (req, res, { familyId, profileId, actor }) => {
  await actions.perform(profileId, 'approve_guardian_template', req.body || {});
  return res.json(await templates.overview(familyId, actor));
});

const retireTemplate = asParent(async (req, res, { familyId, actor }) => {
  await templates.retireTemplate(familyId, req.params.uuid, actor);
  return res.json(await templates.overview(familyId, actor));
});

/** Any adult starts a draft that fits a template. The check runs in the action, not here. */
const startTemplated = asParent(async (req, res, { familyId, profileId }) => {
  await actions.perform(profileId, 'start_templated_mission', { mission: req.params.uuid });
  return res.json(await planning.workspace(familyId));
});

/** An adult sets a step's secret code. It's hashed at once and never comes back. */
const setCode = asParent(async (req, res, { familyId, actor }) => {
  await proof.setCode(familyId, req.params.uuid, req.body?.code, actor);
  return res.json(await missions.overview(familyId));
});

/** An adult ends a live mission that can't finish by itself, and it's graded as it stands. */
const finish = asParent(async (req, res, { familyId, actor }) => {
  await debrief.finish(familyId, req.params.uuid, actor);
  return res.json(await missions.overview(familyId));
});

/** Anyone in the family enters a code from the Companion or a device token. */
const submitCode = asMember(async (req, res, { familyId, actor }) => res.json(await proof.submitCode(familyId, req.params.uuid, req.body?.code, actor)));

/** A kid's open asks: only what was really sent to them, and never a code. */
const kidSteps = async (actor) => {
  if (!actor) return { steps: [] };
  const [rows] = await require('../helpers/db').query(
    `SELECT s.uuid, s.instruction, s.place, s.proof_required, s.due_at, m.title AS mission
     FROM athena_gm_mission_step s JOIN athena_gm_mission m ON m.id = s.mission_id
     WHERE m.family_id = ? AND m.status = 'running' AND m.phase = 'live' AND s.phase = 'live'
       AND s.assigned_actor_id = ? AND s.sent_at IS NOT NULL AND s.status = 'waiting_kids'
     ORDER BY s.seq`,
    [actor.family_id, actor.id]
  );
  return { steps: rows.map((r) => ({ uuid: r.uuid, instruction: r.instruction, place: r.place, proof: r.proof_required, dueAt: r.due_at, mission: r.mission })) };
};

const mySteps = asGuardian(async (req, res, { actor }) => res.json(await kidSteps(actor)));

const myCode = asGuardian(async (req, res, { actor }) => {
  if (!actor) return res.status(409).json({ success: false, message: 'Your family has not joined yet.' });
  const out = await proof.submitCode(Number(actor.family_id), req.params.uuid, req.body?.code, actor);
  return res.json({ ...out, ...(await kidSteps(actor)) });
});

const myDone = asGuardian(async (req, res, { actor }) => {
  if (!actor) return res.status(409).json({ success: false, message: 'Your family has not joined yet.' });
  const step = await missions.stepByUuid(Number(actor.family_id), req.params.uuid);
  if (Number(step.assigned_actor_id) !== Number(actor.id)) return res.status(403).json({ success: false, message: 'That step is for someone else.' });
  await missions.replyToStep(Number(actor.family_id), req.params.uuid, { actorId: actor.id, reply: 'done', via: 'app' });
  return res.json(await kidSteps(actor));
});

/**
 * POST /internal/guardian-missions/tick: not a person's route. A Cloud Task
 * booked for a step's deadline, or the incidents job as a backstop, with a
 * Google-signed ID token for an allowed service account. Nothing in the body
 * is read: it only says "look at what's due".
 */
const tick = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!(await dispatch.verifyCaller(req))) return res.status(401).json({ message: 'Unauthorized' });
  try {
    return res.json(await runner.tick(scout.deliverer(push)));
  } catch (err) {
    console.error('[guardian missions] tick failed:', err?.message);
    // 503 lets Cloud Tasks retry.
    return res.status(503).json({ message: 'Guardians tick failed' });
  }
};

const decline = asParent(async (req, res, { familyId, profileId }) => {
  await missions.declineMission(familyId, profileId, req.params.uuid);
  return res.json(await missions.overview(familyId));
});

const stop = asParent(async (req, res, { familyId, actor }) => {
  await missions.stopMission(familyId, req.params.uuid, { actorId: actor.id, reason: 'stopped by a parent' });
  return res.json(await missions.overview(familyId));
});

const stopEverything = asParent(async (req, res, { familyId, actor }) => {
  await missions.stopAll(familyId, { actorId: actor.id, reason: 'stop everything' });
  return res.json(await missions.overview(familyId));
});

const pause = asParent(async (req, res, { familyId, profileId }) => {
  await missions.setMissionPaused(familyId, profileId, req.params.uuid, Boolean(req.body?.paused));
  return res.json(await missions.overview(familyId));
});

/** Ask someone to scout. With no recipient named, the ask goes to the parent asking. */
const requestScout = asParent(async (req, res, { familyId, actor }) => {
  const b = req.body || {};
  const recipient = b.recipient ? await missions.actorByUuid(familyId, b.recipient) : actor;
  const dueAt = b.dueAt && !Number.isNaN(new Date(b.dueAt).getTime()) ? new Date(b.dueAt) : null;
  const place = typeof b.place === 'string' && b.place.trim() ? b.place.trim().slice(0, 200) : null;
  const result = await scout.requestScout(familyId, { recipientKey: recipient.actor_key, place, dueAt }, push);
  return res.json({ ...result, overview: await missions.overview(familyId) });
});

/** A parent's own agreement and each of their kids', with the words to read. */
const consentView = async (familyId, parent) => {
  const [rows] = await require('../helpers/db').query("SELECT * FROM athena_gm_actor WHERE family_id = ? AND kind IN ('parent','kid') ORDER BY id", [familyId]);
  const people = rows.filter((a) => a.kind === 'kid' || Number(a.id) === Number(parent.id));
  const [terms, standings] = await Promise.all([consent.currentTerms(), consent.standingsFor(familyId, people)]);
  return {
    people: people.map((a) => {
      const audience = a.kind === 'kid' ? 'parent_for_child' : 'adult';
      const role = a.kind === 'kid' ? 'parent' : 'self';
      const s = standings[a.id];
      const term = terms[audience];
      return {
        uuid: a.uuid,
        name: a.display_name,
        kind: a.kind,
        status: s.status,
        needsYou: s.missing.includes(role),
        mayLeave: a.kind === 'kid' || s.status === 'agreed',
        terms: term ? { id: term.id, version: term.version, title: term.title, body: term.body } : null,
      };
    }),
  };
};

const consentOverview = asParent(async (req, res, { familyId, actor }) => res.json(await consentView(familyId, actor)));

const agree = asParent(async (req, res, { familyId, actor }) => {
  const subject = await missions.actorByUuid(familyId, req.params.uuid);
  await consent.agree({ subject, decider: actor, termsId: req.body?.termsId, method: req.body?.method === 'settings' ? 'settings' : 'app_prompt' });
  return res.json(await consentView(familyId, actor));
});

const withdraw = asParent(async (req, res, { familyId, actor }) => {
  const subject = await missions.actorByUuid(familyId, req.params.uuid);
  await consent.withdraw({ subject, decider: actor, method: 'settings' });
  return res.json(await consentView(familyId, actor));
});

const kidView = async (actor) => {
  if (!actor) return { enrolled: false };
  const [terms, state] = await Promise.all([consent.currentTerms(), consent.standingFor(actor)]);
  const term = terms.child;
  return {
    enrolled: true,
    status: state.status,
    needsYou: state.missing.includes('self'),
    waitingOnParent: state.missing.includes('parent'),
    terms: term ? { id: term.id, version: term.version, title: term.title, body: term.body } : null,
  };
};

const myConsent = asGuardian(async (req, res, { actor }) => res.json(await kidView(actor)));

const myAgree = asGuardian(async (req, res, { actor }) => {
  if (!actor) return res.status(409).json({ success: false, message: 'Your family has not joined yet.' });
  await consent.agree({ subject: actor, decider: actor, termsId: req.body?.termsId, method: 'guardians_app' });
  return res.json(await kidView(actor));
});

const myWithdraw = asGuardian(async (req, res, { actor }) => {
  if (!actor) return res.status(409).json({ success: false, message: 'Your family has not joined yet.' });
  await consent.withdraw({ subject: actor, decider: actor, method: 'guardians_app' });
  return res.json(await kidView(actor));
});

/** A notification button or the app: done / can't right now / pause / stop. */
const reply = asMember(async (req, res, { familyId, actor }) => {
  const via = ['push', 'sms', 'app', 'voice'].includes(req.body?.via) ? req.body.via : 'app';
  const step = await missions.replyToStep(familyId, req.params.uuid, { actorId: actor.id, reply: req.body?.reply, text: req.body?.text || null, via });
  return res.json({ step: { uuid: step.uuid, status: step.status } });
});

/**
 * One scouting photo from the phone, with the sensors' reading at capture.
 * When the set has all four directions, analysis starts in the background:
 * the upload is not held open while a model looks at four photos.
 */
const photo = asMember(async (req, res, { familyId, actor }) => {
  const b = req.body || {};
  const saved = await scout.savePhoto(familyId, actor, req.params.uuid, {
    imageBase64: b.image,
    contentType: b.contentType,
    direction: b.direction,
    setUuid: b.set,
    lat: b.lat,
    lng: b.lng,
    accuracy: b.accuracy,
    heading: b.heading,
    pitch: b.pitch,
    capturedAt: b.capturedAt,
  });
  if (saved.complete) {
    scout
      .analyzeSet(familyId, req.params.uuid, saved.setUuid, llm)
      .then((r) => missions.flushHeld(familyId).then(() => r))
      .catch((err) => console.warn('[guardian missions] scout analysis failed:', err.message));
  }
  return res.json(saved);
});

const verify = asParent(async (req, res, { familyId, actor }) => {
  if (typeof req.body?.matches !== 'boolean') return res.status(400).json({ success: false, message: 'matches must be true or false.' });
  await scout.verify(familyId, req.params.uuid, { matches: req.body.matches, note: req.body?.note || null, actorId: actor.id });
  return res.json(await missions.overview(familyId));
});

/** Send a held or unsent step now (it still passes every gate). */
const send = asParent(async (req, res, { familyId }) => {
  const decision = await missions.sendStep(familyId, req.params.uuid, scout.deliverer(push));
  return res.json({ decision, overview: await missions.overview(familyId) });
});

const cameras = asParent(async (req, res) => res.json(await house.cameras()));

/**
 * A parent's "Test" on a house capability: the person's own click, so it
 * isn't held to mission mode, but the kill switch and the capability's own
 * switch still apply (house.permit). Each test writes its own result.
 */
const testCapability = asParent(async (req, res, { familyId, actor }) => {
  const cap = await missions.capabilityByUuid(familyId, req.params.uuid);
  const by = { kind: 'parent', actor };
  const serial = typeof req.body?.serial === 'string' ? req.body.serial : null;
  let result;
  if (cap.cap_key === 'porch_light') {
    result = await house.porchLight(familyId, true, by);
    if (result.ok) {
      await new Promise((r) => setTimeout(r, 2000));
      result = await house.porchLight(familyId, false, by);
    }
  } else if (cap.cap_key === 'morse_out_light') result = await house.morse(familyId, 'SOS', by);
  else if (cap.cap_key === 'pan_tilt_camera') {
    result = await house.pan(familyId, serial, { direction: 'right', steps: 1 }, by);
    if (result.ok) result = await house.pan(familyId, serial, { direction: 'left', steps: 1 }, by);
  } else if (cap.cap_key === 'speak_through_camera') result = await house.say(familyId, serial, 'Hello Guardians. This is Athena, testing my voice.', by, llm.speech);
  else if (cap.cap_key === 'view_cameras' || cap.cap_key === 'doorbell_camera') result = await house.look(familyId, serial, by);
  else return res.status(400).json({ success: false, message: `${cap.name} has no test button yet; a mission tests it.` });
  return res.json({ result: { ok: result.ok, error: result.error || null, latencyMs: result.latencyMs }, overview: await missions.overview(familyId) });
});

module.exports = { handoff, addZone, retireZone, addTemplate, retireTemplate, startTemplated, planningOverview, draft, revise, decideWish, go, tick, setCode, finish, submitCode, mySteps, myCode, myDone, consentOverview, agree, withdraw, myConsent, myAgree, myWithdraw, cameras, testCapability, overview, saveControl, saveCapability, saveRecipient, saveSkill, approve, decline, stop, stopEverything, pause, requestScout, reply, photo, verify, send };
