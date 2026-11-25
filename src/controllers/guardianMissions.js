const { resolveActor, requireAdultActor } = require('../helpers/actor');
const missions = require('../services/guardianMissions');
const consent = require('../services/guardianMissions/consent');
const { decodeGuardianFromRequest } = require('../helpers/guardianToken');
const scout = require('../services/guardianMissions/scout');
const house = require('../services/guardianMissions/house');
const runner = require('../services/guardianMissions/runner');
const proof = require('../services/guardianMissions/proof');
const cameraCheck = require('../services/guardianMissions/cameraCheck');
const debrief = require('../services/guardianMissions/debrief');
const planning = require('../services/guardianMissions/planning');
const templates = require('../services/guardianMissions/templates');
const partners = require('../services/guardianMissions/partners');
const story = require('../services/guardianMissions/story');
const settings = require('../services/guardianMissions/settings');
const voiceprints = require('../services/guardianMissions/voiceprints');
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
  storyProblems: runner.storyProblems,
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

/** When the grown-ups plan to press Go, for the kids' countdown. Starts nothing. */
const schedule = asParent(async (req, res, { familyId, actor }) => {
  await missions.setPlannedFor(familyId, req.params.uuid, req.body?.plannedFor ?? null, actor?.id || null);
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

/** An adult says they're at the camera, so she looks now. Only what she sees finishes the step. */
const look = asParent(async (req, res, { familyId, actor }) => {
  const seen = await cameraCheck.lookNow(familyId, req.params.uuid, actor, { llm });
  return res.json({ ...(await missions.overview(familyId)), look: seen });
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
    `SELECT s.uuid, s.plan_key, s.instruction, s.place, s.proof_required, s.due_at, m.title AS mission, m.plan
     FROM athena_gm_mission_step s JOIN athena_gm_mission m ON m.id = s.mission_id
     WHERE m.status = 'running' AND m.phase = 'live' AND s.phase = 'live'
       AND s.assigned_actor_id = ? AND s.sent_at IS NOT NULL AND s.status = 'waiting_kids'
     ORDER BY s.seq`,
    [actor.id]
  );
  const ready = await runner.kidGoMissions(actor);
  const [ended] = await require('../helpers/db').query(
    `SELECT DISTINCT m.uuid, m.title, m.plan
     FROM athena_gm_mission m JOIN athena_gm_mission_step s ON s.mission_id = m.id
     WHERE s.assigned_actor_id = ? AND s.sent_at IS NOT NULL AND m.status IN ('completed','stopped')
       AND m.ended_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    [actor.id]
  );
  const planOf = (row) => (typeof row.plan === 'string' ? JSON.parse(row.plan) : row.plan);
  return {
    ready: ready.map((m) => ({ uuid: m.uuid, title: story.forKid(planOf(m), { title: m.title }).mission })),
    steps: rows.map((r) => ({ uuid: r.uuid, ...story.forKid(planOf(r), { planKey: r.plan_key, title: r.mission, instruction: r.instruction }), place: r.place, proof: r.proof_required, dueAt: r.due_at })),
    // What they really helped with, for a while after it ended, however it ended.
    reveals: ended.map((m) => ({ uuid: m.uuid, ...planOf(m)?.story })).filter((m) => m.reveal).map(({ uuid, title, reveal }) => ({ uuid, title, reveal })),
  };
};

const mySteps = asGuardian(async (req, res, { actor }) => res.json(await kidSteps(actor)));

/**
 * The same kid-side handlers, reached from a kid's own Companion sign-in
 * instead of the Guardians app. Only a child profile gets through, and only to
 * its own kid actor: an adult or a parent actor is refused, and the body never
 * names whose steps these are.
 */
const asKid = (fn) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let who;
  try {
    who = await resolveActor(req);
  } catch {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  if (who.audience === 'adult') return res.status(403).json({ success: false, message: 'This is the kids\' side.' });
  try {
    const [rows] = await require('../helpers/db').query("SELECT * FROM athena_gm_actor WHERE profile_id = ? AND kind = 'kid' ORDER BY id LIMIT 1", [who.profileId]);
    return await fn(req, res, { actor: rows[0] || null, profileId: who.profileId });
  } catch (err) {
    return answerError(res, err);
  }
};

/** The step is on their screen, which starts its clock if nothing reached a phone. */
const seenStep = async (req, res, { actor }) => {
  if (!actor) return res.status(409).json({ success: false, message: 'Your family has not joined yet.' });
  await runner.stepSeen(await partners.stepFamilyFor(actor, req.params.uuid), req.params.uuid, actor);
  return res.json(await kidSteps(actor));
};
const mySeen = asGuardian(seenStep);

const codeStep = async (req, res, { actor }) => {
  if (!actor) return res.status(409).json({ success: false, message: 'Your family has not joined yet.' });
  const out = await proof.submitCode(await partners.stepFamilyFor(actor, req.params.uuid), req.params.uuid, req.body?.code, actor);
  return res.json({ ...out, ...(await kidSteps(actor)) });
};
const myCode = asGuardian(codeStep);

const doneStep = async (req, res, { actor }) => {
  if (!actor) return res.status(409).json({ success: false, message: 'Your family has not joined yet.' });
  const familyId = await partners.stepFamilyFor(actor, req.params.uuid);
  const step = await missions.stepByUuid(familyId, req.params.uuid);
  if (Number(step.assigned_actor_id) !== Number(actor.id)) return res.status(403).json({ success: false, message: 'That step is for someone else.' });
  await missions.replyToStep(familyId, req.params.uuid, { actorId: actor.id, reply: 'done', via: 'app' });
  return res.json(await kidSteps(actor));
};
const myDone = asGuardian(doneStep);

const photoStep = async (req, res, { actor }) => {
  if (!actor) return res.status(409).json({ success: false, message: 'Your family has not joined yet.' });
  const familyId = await partners.stepFamilyFor(actor, req.params.uuid);
  const out = await proof.submitPhoto(familyId, req.params.uuid, { imageBase64: req.body?.image, contentType: req.body?.contentType }, actor, llm);
  return res.json({ ...out, ...(await kidSteps(actor)) });
};
const myPhoto = asGuardian(photoStep);

/** A kid presses Go, where a template allows it. Their parents hear about it at once. */
const goMission = async (req, res, { actor }) => {
  if (!actor) return res.status(409).json({ success: false, message: 'Your family has not joined yet.' });
  await runner.kidGo(actor, req.params.uuid, {
    deliver: scout.deliverer(push),
    tellAdults: (adults, body) => Promise.all(adults.filter((a) => a.profile_id).map((a) => push.sendToProfile(a.profile_id, { title: 'Athena', body }).catch(() => null))),
  });
  return res.json(await kidSteps(actor));
};
const myGo = asGuardian(goMission);

const kidSeen = asKid(seenStep);
const kidCode = asKid(codeStep);
const kidDone = asKid(doneStep);
const kidGo = asKid(goMission);
const kidPhoto = asKid(photoStep);

// I Spy (11-23): a kid's own game, from their Companion sign-in.
const ispy = require('../services/guardianMissions/ispy');
const noGame = (res) => res.status(409).json({ success: false, message: "There's no I Spy game going right now." });
/**
 * Signal Relay runs a kid finished on their tablet, often offline, sent once
 * Base answers again (11-24). Their own kid actor only; a run sent twice is
 * recorded once.
 */
const kidRelay = asKid(async (req, res, { actor }) => {
  if (!actor) return res.status(409).json({ success: false, message: 'Your family has not joined yet.' });
  return res.json(await require('../services/guardianMissions/relay').record(actor, req.body?.runs));
});
const ispyState = asKid(async (req, res, { actor }) => res.json({ game: await ispy.state(actor) }));
const ispyRetry = asKid(async (req, res, { actor }) => {
  if (!actor) return noGame(res);
  return res.json({ game: await ispy.retryGuess(actor, req.params.uuid, llm) });
});
const ispySpy = asKid(async (req, res, { actor }) => {
  if (!actor) return noGame(res);
  return res.json({ game: await ispy.kidSpies(actor, { imageBase64: req.body?.image, contentType: req.body?.contentType, clue: req.body?.clue, answer: req.body?.answer }, llm) });
});
const ispyAthena = asKid(async (req, res, { actor }) => {
  if (!actor) return noGame(res);
  return res.json({ game: await ispy.athenaSpies(actor, { imageBase64: req.body?.image, contentType: req.body?.contentType }, llm) });
});
/** A parent's practice I Spy from Companion → Guardians: the live model, nothing stored. */
const ispyDemoGuess = asParent(async (req, res) => res.json(await ispy.demoGuess({ imageBase64: req.body?.image, contentType: req.body?.contentType, clue: req.body?.clue, hints: req.body?.hints, clues: req.body?.clues, wrong: req.body?.wrong }, llm)));
const ispyDemoClue = asParent(async (req, res) => res.json(await ispy.demoClue({ imageBase64: req.body?.image, contentType: req.body?.contentType, answer: req.body?.answer, given: req.body?.given }, llm)));
// Clue cards (11-24): the spy answers Athena's ask; a kid asks Athena on her round.
const ispyGiveClue = asKid(async (req, res, { actor }) => {
  if (!actor) return noGame(res);
  if (typeof req.body?.key !== 'string') return res.status(400).json({ success: false, message: 'Pick a clue.' });
  return res.json({ game: await ispy.giveClue(actor, req.params.uuid, req.body.key, llm) });
});
const ispyAskClue = asKid(async (req, res, { actor }) => {
  if (!actor) return noGame(res);
  return res.json({ game: await ispy.requestClue(actor, req.params.uuid, llm) });
});
const ispyDemoPick = asParent(async (req, res) => res.json(await ispy.demoPick({ imageBase64: req.body?.image, contentType: req.body?.contentType }, llm)));
const ispyDemoCheck = asParent(async (req, res) => res.json(ispy.demoCheck(req.body || {})));
const ispyJudge = asKid(async (req, res, { actor }) => {
  if (!actor) return noGame(res);
  if (typeof req.body?.right !== 'boolean') return res.status(400).json({ success: false, message: 'right must be true or false.' });
  return res.json({ game: await ispy.judge(actor, req.params.uuid, { right: req.body.right, hint: req.body?.hint }, llm) });
});
const ispyGuess = asKid(async (req, res, { actor }) => {
  if (!actor) return noGame(res);
  const { right, ...game } = await ispy.guess(actor, req.params.uuid, req.body?.guess, llm);
  return res.json({ right, game });
});
const ispyReveal = asKid(async (req, res, { actor }) => {
  if (!actor) return noGame(res);
  return res.json({ game: await ispy.reveal(actor, req.params.uuid) });
});
const ispyPhoto = asKid(async (req, res, { actor }) => {
  if (!actor) return noGame(res);
  const { buf, type } = await ispy.roundPhoto(actor, req.params.uuid);
  res.set('Content-Type', type);
  return res.send(buf);
});

/**
 * Where each of this kid's quests stands, as a trail of stops: done, the one
 * they're on, and the ones still hidden. Never a step's adult wording, and
 * never what a later stop asks.
 */
const kidTrails = async (actor) => {
  const [rows] = await require('../helpers/db').query(
    `SELECT m.uuid, m.title, m.plan, m.started_at, s.status, s.sent_at
     FROM athena_gm_mission m JOIN athena_gm_mission_step s ON s.mission_id = m.id
     WHERE s.assigned_actor_id = ? AND m.status IN ('approved','running','paused')
     ORDER BY m.started_at DESC, m.id DESC, s.seq`,
    [actor.id]
  );
  const byMission = new Map();
  for (const r of rows) {
    if (!byMission.has(r.uuid)) {
      const plan = typeof r.plan === 'string' ? JSON.parse(r.plan) : r.plan;
      byMission.set(r.uuid, { uuid: r.uuid, title: story.forKid(plan, { title: r.title }).mission, stops: [] });
    }
    const done = ['done', 'declined'].includes(r.status);
    byMission.get(r.uuid).stops.push(done ? 'done' : r.sent_at ? 'current' : 'locked');
  }
  return [...byMission.values()];
};

/**
 * A kid's Base screen in Companion: their open step, their quest trail, their
 * Guardian card, their squad and what Athena has learned. First names only,
 * the same as the parents' Guardians page; no codes, no controls, no cameras.
 * A child with no Guardians actor still gets an answer, so the page can greet
 * them instead of failing.
 */
const kidHome = asKid(async (req, res, { actor }) => {
  const db = require('../helpers/db');
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || null;
  const surname = (n) => { const parts = String(n || '').trim().split(/\s+/); return parts.length > 1 ? parts[parts.length - 1] : null; };
  if (!actor) return res.json({ guardian: false, name: null, steps: [], ready: [], reveals: [], trails: [], history: [], upcoming: [], mysteries: 0, record: null, badges: null, athenaCard: null, me: null, squad: [], squadName: null, squads: [], others: [], feed: [], weekFinds: 0, athena: [], clues: null, skills: [], specialists: [], kit: [], adventure: null, stopWord: null });
  const [own, trails, view, history, plans, [credRows]] = await Promise.all([
    kidSteps(actor),
    kidTrails(actor),
    missions.overview(Number(actor.family_id)),
    kidHistory(actor),
    kidPlans(actor),
    actor.guardian_credential_id ? db.query('SELECT adventure_key, guardian_id FROM guardian_credential WHERE id = ?', [actor.guardian_credential_id]) : Promise.resolve([[]]),
  ]);
  const adventureKey = credRows[0]?.adventure_key || null;
  // The rows behind their four counters, so each one can open its list.
  const detail = await require('../services/guardianMissions/team').memberDetail(adventureKey, credRows[0]?.guardian_id);
  const legacy = await legacyPast(actor, detail);
  // Mission badges (owner, 11-24): theirs, the ones their approved missions will give, and Athena's card.
  const badgeSvc = require('../services/guardianMissions/badges');
  const [[liveRows], mine_] = await Promise.all([
    db.query("SELECT DISTINCT s.mission_id AS id FROM athena_gm_mission_step s JOIN athena_gm_mission m ON m.id = s.mission_id WHERE s.assigned_actor_id = ? AND m.status IN ('running','paused')", [actor.id]),
    badgeSvc.earned(actor.id),
  ]);
  const ahead = (await badgeSvc.waiting([...plans.approvedIds, ...liveRows.map((r) => r.id)])).filter((b) => !mine_.some((e) => e.key === b.key));
  const athenaCard = await badgeSvc.athenaCard(Number(actor.family_id));
  const badgeFor = new Map(ahead.map((b) => [b.mission, b]));
  const [legacyTitles] = await db.query("SELECT mission_key, title, status FROM athena_gm_mission WHERE family_id = ? AND source = 'legacy'", [actor.family_id]);
  const titleOf = new Map(legacyTitles.map((m) => [m.mission_key, m.title]));
  // The mission's own state wins over a kid's start row, which can stay 'active' after it ended.
  const statusOf = new Map(legacyTitles.map((m) => [m.mission_key, m.status]));
  const missionTitle = (key) => titleOf.get(key) || String(key || '').replace(/^mission-\d+-/, '').split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  // Squads are the families on the adventure, by surname, the way the Guardians
  // app's own map already names them. First names inside, nothing else.
  const [[team], [[week]]] = adventureKey
    ? await Promise.all([
        db.query("SELECT display_name FROM guardian_credential WHERE adventure_key = ? AND participant_type = 'guardian' AND is_active = 1", [adventureKey]),
        db.query('SELECT COUNT(*) AS n FROM guardian_index_find WHERE adventure_key = ? AND found_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)', [adventureKey]),
      ])
    : [[[]], [[{ n: 0 }]]];
  const surnameOf = new Map(team.map((t) => [String(firstName(t.display_name)).toLowerCase(), surname(t.display_name)]));
  const name = firstName(actor.display_name);
  const roster = view.team?.roster || [];
  const mine = roster.find((g) => g.name.toLowerCase() === String(name).toLowerCase());
  const kids = view.guardians || [];
  const badges = kids.find((g) => g.uuid === actor.uuid)?.badges || [];
  const levelOf = (list, skillName) => list.find((b) => b.name === skillName)?.level || 'untested';
  const topSkill = badges.find((b) => b.level === 'reliable') || badges.find((b) => b.level === 'learning') || null;
  const card = (g) => ({ name: g.name, level: g.level, role: g.role });
  const others = roster.filter((g) => !g.ours);
  const squads = new Map();
  for (const g of others) {
    const key = surnameOf.get(g.name.toLowerCase()) || 'Other';
    if (!squads.has(key)) squads.set(key, []);
    squads.get(key).push(card(g));
  }
  const { ADVENTURE_LABELS, ADVENTURE_KITS } = require('./prompt');
  const skills = view.skills || [];
  return res.json({
    guardian: true,
    name,
    ...own,
    trails,
    // Past quests, newest first: Athena's missions and the Guardians-app ones they were part of.
    history: [...history, ...legacy.filter((m) => !m.running && !history.some((h) => h.title === m.title))]
      .sort((a, b) => new Date(b.endedAt || 0) - new Date(a.endedAt || 0)),
    upcoming: plans.upcoming.map(({ id, ...u }) => ({ ...u, badge: badgeFor.get(u.uuid) ? { name: badgeFor.get(u.uuid).name, art: badgeFor.get(u.uuid).art } : null })),
    badges: { earned: mine_, ahead },
    athenaCard,
    mysteries: plans.mysteries,
    // What each Base counter counts, theirs only.
    record: {
      finds: detail.finds.map((f) => ({ title: f.title, mission: missionTitle(f.mission), at: f.at })),
      keys: detail.keys.map((k) => ({ clue: k.clue, code: k.code, mission: missionTitle(k.mission), at: k.at })),
      pieces: detail.pieces.map((p) => ({ family: p.family, fragment: p.fragment, mission: missionTitle(p.mission), at: p.at })),
      missions: detail.missions.map((m) => ({ title: missionTitle(m.mission), status: statusOf.get(m.mission) || m.status, at: m.at })),
    },
    me: {
      level: mine?.level || 1, role: mine?.role || 'Recruit', levelProgress: mine?.levelProgress || 0,
      xp: mine?.xp || 0, xpPerLevel: mine?.xpPerLevel || 25,
      finds: mine?.finds || 0, trailKeys: mine?.trailKeys || 0, mapPieces: mine?.contributions || 0, missionsStarted: mine?.missionsStarted || 0,
      badges: badges.filter((b) => b.level !== 'untested').length, checkedIn: Boolean(mine?.checkedIn),
      topSkill: topSkill ? { name: topSkill.name, badge: topSkill.badge, level: topSkill.level } : null,
    },
    squad: roster.filter((g) => g.ours).map(card),
    squadName: surname(actor.display_name) || surnameOf.get(String(name).toLowerCase()) || null,
    squads: [...squads.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([family, members]) => ({ name: family, members: members.sort((a, b) => a.name.localeCompare(b.name)) })),
    others: others.map(card),
    feed: (view.team?.activity || []).slice(0, 6).map((a) => ({ who: a.who, text: a.text, at: a.at })),
    weekFinds: Number(week?.n) || 0,
    athena: (view.abilities || []).map((a) => ({ key: a.key, name: a.name, percent: a.percent })),
    clues: view.team?.clues ? { found: view.team.clues.found, total: view.team.clues.total } : null,
    // Every skill the household tracks, and how far this kid is with each.
    skills: skills.map((s) => ({ name: s.name, badge: s.badge, level: levelOf(badges, s.name) })),
    // Who in this household can do what. Own family only.
    specialists: skills
      .map((s) => ({ skill: s.name, badge: s.badge, who: kids.map((k) => ({ name: firstName(k.name), level: levelOf(k.badges || [], s.name) })).filter((w) => w.level !== 'untested') }))
      .filter((s) => s.who.length),
    adventure: adventureKey ? { key: adventureKey, label: ADVENTURE_LABELS[adventureKey] || null } : null,
    kit: (adventureKey && ADVENTURE_KITS[adventureKey]) || [],
    stopWord: view.control?.stopWord || null,
  });
});

/** Every quest this kid was really part of that has ended, newest first, with what it was for. */
/**
 * What's coming for this kid (owner, 11-24). Upcoming: approved, not live yet,
 * with a planned start a parent set, for the countdown. Everything else they're
 * in that hasn't started (approved with no date, or still a parent's proposal)
 * is only counted, so it shows as a locked mystery: no title, nothing promised.
 */
const kidPlans = async (actor) => {
  const [rows] = await require('../helpers/db').query(
    `SELECT * FROM athena_gm_mission WHERE family_id = ? AND source <> 'legacy'
       AND ((status = 'running' AND (phase IS NULL OR phase IN ('prep','ready'))) OR status = 'proposed')`,
    [actor.family_id]
  );
  const planOf = (m) => (typeof m.plan === 'string' ? JSON.parse(m.plan) : m.plan) || {};
  const mine = rows.filter((m) => (planOf(m).steps || []).some((s) => s.actor === actor.actor_key));
  const upcoming = mine
    .filter((m) => m.status === 'running' && m.approval_state === 'approved' && m.planned_for)
    .sort((a, b) => new Date(a.planned_for) - new Date(b.planned_for))
    .map((m) => ({ uuid: m.uuid, id: m.id, title: story.forKid(planOf(m), { title: m.title }).mission, premise: planOf(m).story?.premise || null, plannedFor: m.planned_for, ready: m.phase === 'ready', game: planOf(m).game?.kind || null }));
  const approvedIds = mine.filter((m) => m.status === 'running' && m.approval_state === 'approved').map((m) => m.id);
  return { upcoming, mysteries: mine.length - upcoming.length, approvedIds };
};

/** The Guardians-app missions (First Watch and the rest) this kid took part in, from their own record. */
const legacyPast = async (actor, detail) => {
  const keys = new Set([...detail.finds, ...detail.keys, ...detail.pieces, ...detail.missions].map((r) => r.mission));
  if (!keys.size) return [];
  const [rows] = await require('../helpers/db').query(
    "SELECT uuid, mission_key, title, status, ended_at, started_at FROM athena_gm_mission WHERE family_id = ? AND source = 'legacy'",
    [actor.family_id]
  );
  return rows
    .filter((m) => keys.has(m.mission_key))
    .map((m) => ({
      uuid: m.uuid, title: m.title, reveal: null, legacy: true,
      finished: m.status === 'completed', running: m.status === 'running', endedAt: m.ended_at || null,
      did: {
        finds: detail.finds.filter((f) => f.mission === m.mission_key).length,
        keys: detail.keys.filter((k) => k.mission === m.mission_key).length,
        pieces: detail.pieces.filter((p) => p.mission === m.mission_key).length,
      },
    }));
};

const kidHistory = async (actor) => {
  const [rows] = await require('../helpers/db').query(
    `SELECT m.uuid, m.title, m.plan, m.status, m.ended_at
     FROM athena_gm_mission m
     WHERE m.status IN ('completed','stopped')
       AND EXISTS (SELECT 1 FROM athena_gm_mission_step s WHERE s.mission_id = m.id AND s.assigned_actor_id = ? AND s.sent_at IS NOT NULL)
     ORDER BY m.ended_at DESC LIMIT 24`,
    [actor.id]
  );
  return rows.map((m) => {
    const plan = typeof m.plan === 'string' ? JSON.parse(m.plan) : m.plan;
    return { uuid: m.uuid, title: story.forKid(plan, { title: m.title }).mission, reveal: plan?.story?.reveal || null, finished: m.status === 'completed', endedAt: m.ended_at };
  });
};

/** A person's own voiceprint, computed on their device. Needs their agreement. */
const saveVoice = asMember(async (req, res, { familyId, actor }) => {
  const print = req.body?.print;
  if (!voiceprints.validPrint(print)) return res.status(400).json({ success: false, message: 'That isn\'t a usable voiceprint.' });
  const standing = await consent.standingFor(actor);
  if (!standing.allowed) return res.status(403).json({ success: false, message: 'Agree to help train Athena first.' });
  const [[row]] = await require('../helpers/db').query("SELECT MAX(id) AS id FROM athena_gm_consent_event WHERE subject_actor_id = ? AND action = 'agree'", [actor.id]);
  await voiceprints.saveVoiceprint({ familyId, actorId: actor.id, model: req.body?.model, print, sampleCount: Number(req.body?.samples) || 1, consentEventId: row?.id });
  return res.json({ saved: true });
});

/** Who might be speaking, inside this family only. A suggestion, and it authorizes nothing. */
const whoSpoke = asMember(async (req, res, { familyId }) => {
  if (!voiceprints.validPrint(req.body?.print)) return res.status(400).json({ success: false, message: 'That isn\'t a usable voiceprint.' });
  const best = voiceprints.bestMatch(req.body.print, await voiceprints.readVoiceprints(familyId, String(req.body?.model || '').slice(0, 80)));
  if (!best) return res.json({ person: null });
  const [rows] = await require('../helpers/db').query('SELECT uuid, display_name FROM athena_gm_actor WHERE id = ?', [best.actorId]);
  return res.json({ person: rows[0] ? { uuid: rows[0].uuid, name: rows[0].display_name } : null, score: Number(best.score.toFixed(3)) });
});

const invite = asParent(async (req, res, { familyId, actor }) => {
  await partners.invite(familyId, req.params.uuid, req.body?.family, actor);
  return res.json(await planning.workspace(familyId));
});

const invitations = asParent(async (req, res, { familyId }) => res.json({ missions: await partners.forFamily(familyId) }));

const answerInvite = asParent(async (req, res, { familyId, actor }) => {
  await partners.respond(familyId, req.params.uuid, req.body?.accept === true, actor);
  return res.json({ missions: await partners.forFamily(familyId) });
});

const leaveMission = asParent(async (req, res, { familyId, actor }) => {
  await partners.leave(familyId, req.params.uuid, actor);
  return res.json({ missions: await partners.forFamily(familyId) });
});

const setSwitch = asParent(async (req, res, { familyId, actor }) => {
  await settings.setSwitch(req.params.key, req.body?.on === true, actor);
  return res.json(await templates.overview(familyId, actor));
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
  const people = rows.filter((a) => consent.isMinor(a) || Number(a.id) === Number(parent.id));
  const [terms, standings] = await Promise.all([consent.currentTerms(), consent.standingsFor(familyId, people)]);
  return {
    people: people.map((a) => {
      const [[role, audience]] = consent.requirementsFor(a);
      const s = standings[a.id];
      const term = terms[audience];
      return {
        uuid: a.uuid,
        name: a.display_name,
        kind: a.kind,
        status: s.status,
        needsYou: s.missing.includes(role),
        mayLeave: consent.isMinor(a) || s.status === 'agreed',
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
  const term = consent.isMinor(actor) ? terms.child : terms.adult;
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

module.exports = { schedule, kidRelay, ispyDemoGuess, ispyDemoClue, ispyGiveClue, ispyAskClue, ispyDemoPick, ispyDemoCheck, ispyState, ispyRetry, ispySpy, ispyAthena, ispyJudge, ispyGuess, ispyReveal, ispyPhoto, kidHome, kidPhoto, kidSeen, kidCode, kidDone, kidGo, myPhoto, myGo, saveVoice, whoSpoke, invite, invitations, answerInvite, leaveMission, setSwitch, handoff, addZone, retireZone, addTemplate, retireTemplate, startTemplated, planningOverview, draft, revise, decideWish, go, tick, setCode, look, finish, submitCode, mySteps, mySeen, myCode, myDone, consentOverview, agree, withdraw, myConsent, myAgree, myWithdraw, cameras, testCapability, overview, saveControl, saveCapability, saveRecipient, saveSkill, approve, decline, stop, stopEverything, pause, requestScout, reply, photo, verify, send };
