// The execution engine (services/projects/execution.js): pure, so no database.
// Right Now's scorers are pure too; its other dependencies are stubbed as in rightNow.test.js.
jest.mock('../../helpers/db', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../llm', () => ({ generateJson: jest.fn() }));
jest.mock('../dashboard', () => ({ cachedDashboard: jest.fn(), getDashboard: jest.fn() }));
jest.mock('../places', () => ({ list: jest.fn(), MAX_PLACES: 25 }));
jest.mock('../weather', () => ({ forecast: jest.fn() }));
jest.mock('../pulsepoint/watch', () => ({ listPlaces: jest.fn() }));
jest.mock('../readCache', () => ({ read: jest.fn(), hash: jest.fn(), invalidate: jest.fn() }));

const ex = require('./execution');
const { rank, forRightNow, heldForRightNow } = require('./rank');
const { projectCandidates, followUpCandidates } = require('../rightNow');

const NOW = Date.parse('2026-10-25T14:00:00Z');
const day = (n) => new Date(NOW + n * 86_400_000).toISOString();

const step = (uuid, title, extra = {}) => ({
  uuid, title, ordinal: Number(uuid.replace(/\D/g, '')) || 0, detail: null, acceptanceCriteria: null,
  status: 'todo', who: 'me', blockedOn: null, waitingOnActor: null, reviewAt: null, unblockAction: null,
  dueOn: null, effortMinutes: null, indoor: null, completedAt: null, dependsOn: [], ...extra,
});
const project = (uuid, extra = {}) => ({
  uuid, title: uuid, status: 'active', effectiveStatus: 'active', priority: 3, primaryArea: 'home', kind: null,
  serves: [], conditions: [], seasonMonths: null, hardDeadline: null, pinnedAt: null, indoor: null, goal: null,
  doneWhen: null, doneWhenConfirmed: [], outcomeConfirmedAt: null, activatedAt: null, lastProgressAt: null,
  steps: [], items: [], sessions: [], effort: { min: null, max: null }, ...extra,
});

/** The owner's side-yard build, as the Companion dashboard shows it. */
function sideYard() {
  return project('side-yard', {
    title: 'Side Yard Trash Shelter & Fence', status: 'planning', effectiveStatus: 'planning', priority: 4, indoor: false,
    conditions: ['dry'], pinnedAt: '2026-10-25T00:00:00Z', lastProgressAt: day(-2),
    doneWhen: [
      'Concrete pad drains away from the house', 'Awning is secure and weather-resistant', 'Fence is stable and 6\' tall',
      'Gate opens and latches correctly', 'Trash cans roll through easily', 'Site is cleaned up', 'Required inspections are complete',
    ].map((c) => `- ${c}`).join('\n'),
    steps: [
      step('s1', 'Produce a dimensioned site layout', { status: 'done' }),
      step('s2', 'Measure and mark the 32-foot fence line', { dependsOn: ['s1'], effortMinutes: 45, indoor: false, detail: 'From the house toward the evergreens.' }),
      step('s3', 'Mark the 4 ft gate opening', { dependsOn: ['s2'], effortMinutes: 20 }),
      step('s4', 'Finalize the triangular extension dimensions', { dependsOn: ['s1'], effortMinutes: 30 }),
      step('s5', 'Coordinate gate-post foundations with the concrete', { dependsOn: ['s3', 's4'] }),
      step('s6', 'Verify the structural wall attachment', {
        status: 'blocked', blockedOn: 'house framing check', waitingOnActor: 'the contractor', reviewAt: day(-1),
      }),
      step('s7', 'Excavate, set footings and pour', { dependsOn: ['s5', 's6'], acceptanceCriteria: 'Forms level\nPosts plumb' }),
      step('s8', 'Build the awning and fence', { dependsOn: ['s7'] }),
      step('s9', 'Install the gate and check clearance', { dependsOn: ['s8'] }),
    ],
    items: [
      { kind: 'material', label: 'Fence posts', value: '5–7', unit: 'posts', status: 'estimate' },
      { kind: 'material', label: 'Ready-mix concrete', value: '1.1–1.3', unit: 'cu yd', status: 'pending' },
      { kind: 'spec', label: 'Gate location', value: null, unit: null, status: 'pending' },
    ],
  });
}

describe('step dependencies', () => {
  it('orders by explicit prerequisites, not display order', () => {
    const p = project('p', { steps: [step('s1', 'B later', { dependsOn: ['s2'] }), step('s2', 'A first')] });
    expect(ex.getExecutableSteps(p, NOW).map((s) => s.uuid)).toEqual(['s2']);
    p.steps[1].status = 'done';
    expect(ex.getExecutableSteps(p, NOW).map((s) => s.uuid)).toEqual(['s1']);
  });

  it('never infers a dependency from order: legacy steps without any are all ready', () => {
    const p = project('p', { steps: [step('s1', 'One'), step('s2', 'Two'), step('s3', 'Three')] });
    expect(ex.getExecutableSteps(p, NOW)).toHaveLength(3);
    expect(ex.getNextAction(p, { now: NOW }).stepUuid).toBe('s1');
  });

  it('needs every prerequisite, and a skipped one holds nothing up', () => {
    const y = sideYard();
    const blockers = ex.getStepBlockers(y, 's5');
    expect(blockers.map((b) => b.stepUuid)).toEqual(['s3', 's4']);
    y.steps.find((s) => s.uuid === 's3').status = 'done';
    expect(ex.getStepBlockers(y, 's5').map((b) => b.stepUuid)).toEqual(['s4']);
    y.steps.find((s) => s.uuid === 's4').status = 'skipped';
    expect(ex.getStepBlockers(y, 's5')).toEqual([]);
  });

  it('keeps a manually blocked step and anything waiting on it out of what is executable', () => {
    const y = sideYard();
    const ready = ex.getExecutableSteps(y, NOW).map((s) => s.uuid);
    expect(ready).toEqual(['s2', 's4']);
    expect(ex.getStepBlockers(y, 's6')[0]).toMatchObject({ kind: 'waiting', action: 'Check with the contractor about house framing check.' });
    expect(ex.getStepBlockers(y, 's7').map((b) => b.kind)).toEqual(['prerequisite', 'prerequisite']);
  });

  it('holds every step of a waiting or dependency-blocked project, saying why', () => {
    const p = project('p', { effectiveStatus: 'blocked', steps: [step('s1', 'Paint')] });
    expect(ex.getExecutableSteps(p, NOW)).toEqual([]);
    const state = ex.getProjectExecutionState(p, { now: NOW, needs: ['Diagnose the odor'] });
    expect(state.noActionReason).toBe('Needs "Diagnose the odor" finished first.');
    expect(state.unblock).toBe('Work on "Diagnose the odor".');
    const held = project('h', { status: 'waiting', effectiveStatus: 'waiting', waitingOn: 'rain', steps: [step('s1', 'Seal')] });
    expect(ex.getProjectExecutionState(held, { now: NOW }).noActionReason).toBe('On hold, waiting on rain.');
  });
});

describe('next action', () => {
  it('explains why it is ready, and degrades gracefully without effort or a window', () => {
    const next = ex.getNextAction(sideYard(), { now: NOW });
    expect(next).toMatchObject({ stepUuid: 's2', title: 'Measure and mark the 32-foot fence line', effortMinutes: 45, indoor: false, fitsWindow: null });
    expect(next.reasons[0]).toBe('everything it needs is done ("Produce a dimensioned site layout")');
  });

  it('marks work that does not fit the window as several sittings instead of dropping it', () => {
    const p = project('p', { steps: [step('s1', 'Pour the pad', { effortMinutes: 240 })] });
    const next = ex.getNextAction(p, { now: NOW, freeMinutes: 60 });
    expect(next).toMatchObject({ fitsWindow: false, needsMultipleSessions: true });
  });

  it('prefers indoor work on a wet day and an in-progress step over a fresh one', () => {
    const p = project('p', { steps: [step('s1', 'Dig', { indoor: false }), step('s2', 'Prime trim', { indoor: true })] });
    expect(ex.getNextAction(p, { now: NOW, wet: true }).stepUuid).toBe('s2');
    p.steps[0].status = 'in_progress';
    expect(ex.getNextAction(p, { now: NOW }).stepUuid).toBe('s1');
  });

  it('advances to the next executable step when one is done', () => {
    const y = sideYard();
    y.steps.find((s) => s.uuid === 's2').status = 'done';
    expect(ex.getExecutableSteps(y, NOW).map((s) => s.uuid)).toEqual(['s3', 's4']);
  });
});

describe('blocker follow-through', () => {
  it('turns a due review date into a follow-up without resolving the blocker', () => {
    const y = sideYard();
    const [f] = ex.getOverdueFollowUps(y, NOW);
    expect(f).toMatchObject({ stepUuid: 's6', due: true, waitingOn: 'the contractor', key: `s6@${day(-1)}` });
    expect(y.steps.find((s) => s.uuid === 's6').status).toBe('blocked');
  });

  it('surfaces a blocker with no review date as needing triage, not as due', () => {
    const p = project('p', { steps: [step('s1', 'Order lumber', { status: 'blocked', blockedOn: 'a quote' })] });
    const [f] = ex.getBlockedStepsNeedingReview(p, NOW);
    expect(f).toMatchObject({ triage: true, due: false, action: 'Sort out a quote.' });
    expect(ex.getOverdueFollowUps(p, NOW)).toEqual([]);
  });

  it('does not repeat a follow-up for the same review date, and raises it again when the date moves', () => {
    const y = sideYard();
    const seen = new Set(ex.newFollowUps(y, new Set(), NOW).map((f) => f.key));
    expect(seen.size).toBe(1);
    expect(ex.newFollowUps(y, seen, NOW)).toEqual([]);
    expect(ex.newFollowUps(y, seen, NOW + 3_600_000)).toEqual([]);
    y.steps.find((s) => s.uuid === 's6').reviewAt = day(2);
    expect(ex.newFollowUps(y, seen, NOW)).toEqual([]);
    expect(ex.newFollowUps(y, seen, NOW + 3 * 86_400_000)).toHaveLength(1);
  });

  it('lists what would clear each blocker, due ones first', () => {
    const p = project('p', {
      steps: [
        step('s1', 'Permit', { status: 'blocked', blockedOn: 'permit response', waitingOnActor: 'the county', reviewAt: day(3), unblockAction: 'Call the permit office' }),
        step('s2', 'Delivery', { status: 'blocked', blockedOn: 'materials delivery', reviewAt: day(-1) }),
      ],
    });
    const list = ex.getUnblockActions(p, NOW);
    expect(list.map((f) => f.stepUuid)).toEqual(['s2', 's1']);
    expect(list[1].action).toBe('Call the permit office');
  });
});

describe('outcome-based completion', () => {
  it('keeps legacy projects without criteria working as before', () => {
    const p = project('p', { steps: [step('s1', 'Do it', { status: 'done' })] });
    expect(ex.getCompletionReadiness(p)).toMatchObject({ state: 'ready_for_confirmation', hasCriteria: false, suggestCriteria: true });
    expect(ex.getCompletionReadiness({ ...p, status: 'done' }).state).toBe('complete');
    expect(ex.getCompletionReadiness(project('q')).state).toBe('work_remaining');
  });

  it('does not equate every step done with a verified outcome', () => {
    const y = sideYard();
    for (const s of y.steps) s.status = 'done';
    const r = ex.getCompletionReadiness(y);
    expect(r).toMatchObject({ state: 'outcome_unverified', openSteps: 0, criteria: { total: 7, confirmed: 0 } });
    expect(ex.getIncompleteAcceptanceCriteria(y)).toHaveLength(7);
    const summary = ex.getProjectCloseoutSummary(y);
    expect(summary).toMatchObject({ needsOwnerConfirmation: true, canClose: true, toVerify: ['Ready-mix concrete', 'Gate location'] });
    expect(summary.criteria[0]).toEqual({ text: 'Concrete pad drains away from the house', confirmed: false });
  });

  it('is ready for confirmation once every check is confirmed, and verified only when closed with it', () => {
    const y = sideYard();
    for (const s of y.steps) s.status = 'done';
    y.doneWhenConfirmed = ex.getProjectCloseoutSummary(y).criteria.map((c) => c.text);
    expect(ex.getCompletionReadiness(y).state).toBe('ready_for_confirmation');
    expect(ex.getCompletionReadiness({ ...y, status: 'done', outcomeConfirmedAt: day(0) }).state).toBe('verified_complete');
  });

  it('counts step acceptance criteria on open steps as incomplete', () => {
    const open = ex.getIncompleteAcceptanceCriteria(sideYard()).filter((c) => c.source === 'step');
    expect(open).toEqual([
      { source: 'step', stepUuid: 's7', stepTitle: 'Excavate, set footings and pour', text: 'Forms level' },
      { source: 'step', stepUuid: 's7', stepTitle: 'Excavate, set footings and pour', text: 'Posts plumb' },
    ]);
  });
});

describe('work sessions', () => {
  const session = (uuid, start, extra = {}) => ({ uuid, stepUuid: null, plannedStart: start, plannedMinutes: 60, status: 'planned', calendarEventId: null, ...extra });

  it('suggests a realistic block from effort and free time, on a quarter hour', () => {
    const s2 = sideYard().steps[1];
    const windows = [{ start: '2026-10-25T14:05:00Z', end: '2026-10-25T14:35:00Z' }, { start: '2026-11-01T13:00:00Z', end: '2026-11-01T15:00:00Z' }];
    expect(ex.suggestWorkSession(s2, { windows, now: NOW })).toMatchObject({ plannedStart: '2026-11-01T13:00:00.000Z', plannedMinutes: 45, fitsInOne: true });
  });

  it('falls back to part of the work, or to manual scheduling without a calendar', () => {
    const big = step('s1', 'Pour', { effortMinutes: 240 });
    expect(ex.suggestWorkSession(big, { windows: [{ start: '2026-11-01T13:00:00Z', end: '2026-11-01T15:00:00Z' }], now: NOW }))
      .toMatchObject({ plannedMinutes: 120, fitsInOne: false });
    expect(ex.suggestWorkSession(big, {})).toMatchObject({ plannedStart: null, reason: 'no calendar to check — pick a time' });
    expect(ex.suggestWorkSession(step('s2', 'Unknown'), {}).plannedMinutes).toBe(60);
  });

  it('knows what is upcoming, what needs a check-in, and what is unscheduled', () => {
    const y = sideYard();
    y.sessions = [session('w1', day(7), { stepUuid: 's2' }), session('w0', day(-2), { stepUuid: 's4' })];
    expect(ex.upcomingSessions(y, NOW).map((s) => s.uuid)).toEqual(['w1']);
    expect(ex.sessionsToCheckIn(y, NOW).map((s) => s.uuid)).toEqual(['w0']);
    expect(ex.getUnscheduledExecutableSteps(y, NOW).map((s) => s.uuid)).toEqual(['s4']);
  });

  it('prepares a session with the work, materials, things to verify, blockers and weather', () => {
    const y = sideYard();
    const prep = ex.getSessionPreparation(session('w', day(1), { stepUuid: 's7' }), y, { forecast: { outlook: 'wet', summary: 'Rain after 2pm' } });
    expect(prep.work).toMatchObject({ title: 'Excavate, set footings and pour', acceptanceCriteria: ['Forms level', 'Posts plumb'] });
    expect(prep.materials.map((m) => m.label)).toEqual(['Fence posts', 'Ready-mix concrete']);
    expect(prep.toVerify).toEqual(['Gate location']);
    expect(prep.blockers.map((b) => b.stepUuid)).toEqual(['s5', 's6']);
    expect(prep.weather).toMatchObject({ outdoor: true, needs: ['dry'], warning: expect.stringMatching(/Rain is forecast/) });
  });

  it('never treats a completed session as a completed step', () => {
    const y = sideYard();
    y.sessions = [session('w', day(-1), { stepUuid: 's2', status: 'completed', actualMinutes: 50 })];
    expect(ex.getExecutableSteps(y, NOW).map((s) => s.uuid)).toContain('s2');
    expect(ex.getProjectCloseoutSummary(y).minutesWorked).toBe(50);
  });
});

describe('phases', () => {
  it('groups steps by phase in order of first appearance, unlabelled last, with progress and dates', () => {
    const p = project('p', {
      steps: [
        step('s1', 'Layout', { phase: 'Design', status: 'done', dueOn: '2026-10-27' }),
        step('s2', 'Loose step'),
        step('s3', 'Order posts', { phase: 'Procurement', dueOn: '2026-11-04' }),
        step('s4', 'Permit', { phase: 'Design', status: 'blocked', dueOn: '2026-11-01' }),
        step('s5', 'Old idea', { phase: 'Design', status: 'skipped' }),
      ],
      sessions: [{ uuid: 'w', stepUuid: 's3', plannedStart: '2026-11-02T13:00:00.000Z', plannedMinutes: 60, status: 'planned' }],
    });
    expect(ex.getPhases(p)).toEqual([
      { name: 'Design', stepUuids: ['s1', 's4', 's5'], done: 1, total: 2, blocked: 1, from: '2026-10-27', to: '2026-11-01' },
      { name: 'Procurement', stepUuids: ['s3'], done: 0, total: 1, blocked: 0, from: '2026-11-02', to: '2026-11-04' },
      { name: null, stepUuids: ['s2'], done: 0, total: 1, blocked: 0, from: null, to: null },
    ]);
  });

  it('is empty when no step has a phase, and never changes what is ready', () => {
    const plain = project('p', { steps: [step('s1', 'A'), step('s2', 'B')] });
    expect(ex.getPhases(plain)).toEqual([]);
    const phased = project('p', { steps: [step('s1', 'A', { phase: 'Later' }), step('s2', 'B', { phase: 'First' })] });
    expect(ex.getExecutableSteps(phased, NOW).map((s) => s.uuid)).toEqual(['s1', 's2']);
    expect(ex.getProjectExecutionState(phased, { now: NOW }).nextAction.phase).toBe('Later');
  });
});

describe('the plan across projects', () => {
  const graph = (projects, links = []) => ({ projects, links, concerns: [], charters: [] });

  it('prefers advancing active work over starting new, unless it is urgent or pinned', () => {
    const active = [1, 2, 3].map((n) => project(`a${n}`, { steps: [step('s1', `Active ${n}`)] }));
    const fresh = project('new', { status: 'ready', effectiveStatus: 'ready', priority: 5 - 1, steps: [step('s1', 'Start the new one')] });
    const urgent = project('leak', { status: 'ready', effectiveStatus: 'ready', serves: ['safety'], steps: [step('s1', 'Fix the leak')] });
    const plan = ex.getExecutionPlan(graph([...active, fresh, urgent]), { now: NOW });
    expect(plan.focus).toMatchObject({ active: 3, limit: 3, over: true });
    const byProject = new Map(plan.nextActions.map((a) => [a.projectUuid, a]));
    expect(byProject.get('new').reasons).toContain('would be a new project on top of 3 active');
    expect(byProject.get('leak').urgentStart).toBe(true);
    expect(plan.nextActions[plan.nextActions.length - 1].projectUuid).toBe('new');
    // A preference, never a limit: nothing was paused, dropped or hidden.
    expect(plan.states.map((s) => s.effectiveStatus)).toEqual(['active', 'active', 'active', 'ready', 'ready']);
  });

  it('keeps rank.js ordering and pins intact', () => {
    const g = graph([project('pinned', { pinnedAt: '2026-10-25T00:00:00Z', priority: 1, steps: [step('s1', 'x')] }), project('crit', { priority: 5, steps: [step('s1', 'y')] })]);
    const plan = ex.getExecutionPlan(g, { now: NOW });
    expect(plan.nextActions[0].projectUuid).toBe('pinned');
    expect(rank(g, NOW).get('pinned').why[0]).toBe('you moved it to the front');
  });

  it('counts what is moving and what is stuck', () => {
    const stuck = project('stuck', { steps: [step('s1', 'Wait', { status: 'blocked', blockedOn: 'quote' })] });
    const finished = project('fin', { status: 'done', effectiveStatus: 'done', activatedAt: day(-30), outcomeConfirmedAt: day(-2) });
    const y = sideYard();
    y.sessions = [{ uuid: 'w', plannedStart: day(-3), plannedMinutes: 60, status: 'completed' }, { uuid: 'v', plannedStart: day(-1), plannedMinutes: 60, status: 'planned' }];
    const m = ex.getExecutionPlan(graph([y, stuck, finished]), { now: NOW }).metrics;
    expect(m).toMatchObject({ activeProjects: 1, activeWithNextAction: 0, blockedWithoutFollowUp: 1, verifiedComplete: 1, medianDaysToVerified: 28, sessionsLast30Days: { planned: 2, completed: 1 } });
  });
});

describe('Right Now', () => {
  const graph = (projects) => ({ projects, links: [], concerns: [], charters: [] });

  it('offers the next executable step, with its project and why', () => {
    const y = { ...sideYard(), status: 'active', effectiveStatus: 'active' };
    const plan = ex.getExecutionPlan(graph([y]), { now: NOW });
    const [c] = forRightNow([y], new Date(NOW), plan);
    expect(c).toMatchObject({ uuid: 'side-yard', title: 'Measure and mark the 32-foot fence line', projectTitle: 'Side Yard Trash Shelter & Fence', stepUuid: 's2', effortMinutes: 45, indoor: false });
    const [candidate] = projectCandidates([c], { freeMinutes: 120 }, false);
    expect(candidate).toMatchObject({ id: 'project:side-yard', kind: 'project', fitsWindow: true, multiSession: false, reasons: expect.arrayContaining([expect.stringMatching(/everything it needs is done/)]) });
  });

  it('says why a stuck project is not offered instead of hiding it', () => {
    const p = project('p', { title: 'Garage', steps: [step('s1', 'Seal', { status: 'blocked', blockedOn: 'a dry week', reviewAt: day(4) })] });
    const plan = ex.getExecutionPlan(graph([p]), { now: NOW });
    expect(forRightNow([p], new Date(NOW), plan)).toEqual([]);
    expect(heldForRightNow([p], plan)).toEqual([{ id: 'project:p', title: 'Garage', reason: 'Everything open is waiting — "Seal" on a dry week.', unblock: 'Sort out a dry week.' }]);
  });

  it('offers a due follow-up as its own short candidate, once', () => {
    const plan = ex.getExecutionPlan(graph([sideYard()]), { now: NOW });
    const list = followUpCandidates(plan.followUps);
    expect(list).toEqual([expect.objectContaining({ id: 'followup:s6', kind: 'followup', title: 'Check with the contractor about house framing check.', projectTitle: 'Side Yard Trash Shelter & Fence' })]);
  });

  it('flags a step too big for the window and keeps projects without steps as before', () => {
    const [legacy] = forRightNow([project('l', { title: 'Paint office', effort: { min: 360, max: 480 } })], new Date(NOW), ex.getExecutionPlan(graph([]), { now: NOW }));
    expect(legacy).toMatchObject({ title: 'Paint office', effortMinutes: 360 });
    expect(legacy.stepUuid).toBeUndefined();
    expect(projectCandidates([legacy], { freeMinutes: 60 }, false)[0]).toMatchObject({ fitsWindow: false, multiSession: true });
  });
});

describe('Side Yard, end to end (the definition of done)', () => {
  it('walks from first step to an owner-confirmed closeout', () => {
    const y = sideYard();
    const g = { projects: [y], links: [], concerns: [], charters: [] };
    const state = () => ex.getExecutionPlan(g, { now: NOW, freeMinutes: 120 }).states[0];

    // 1. An executable next action, with why it's ready.
    expect(state().nextAction).toMatchObject({ stepUuid: 's2', fitsWindow: true });
    // 2. Time to do it: a block that holds it, and what to bring.
    const block = ex.suggestWorkSession(y.steps[1], { windows: [{ start: '2026-11-01T13:00:00Z', end: '2026-11-01T16:00:00Z' }], now: NOW });
    y.sessions = [{ uuid: 'w1', stepUuid: 's2', plannedStart: block.plannedStart, plannedMinutes: block.plannedMinutes, status: 'planned', calendarEventId: null }];
    expect(state().upcomingSessions[0].uuid).toBe('w1');
    expect(state().unscheduled.map((s) => s.uuid)).toEqual(['s4']);
    // 3. The unresolved blocker is revisited, once per review date.
    expect(state().dueFollowUps.map((f) => f.stepUuid)).toEqual(['s6']);
    // 4. Work happens; the session finishing doesn't finish the step, the person does.
    y.sessions[0].status = 'completed';
    expect(state().nextAction.stepUuid).toBe('s2');
    y.steps[1].status = 'done';
    expect(state().executableSteps.map((s) => s.uuid)).toEqual(['s3', 's4']);
    // 5. The blocker clears; later steps open up in dependency order.
    Object.assign(y.steps[5], { status: 'done', blockedOn: null, reviewAt: null });
    for (const id of ['s3', 's4', 's5']) y.steps.find((s) => s.uuid === id).status = 'done';
    expect(state().nextAction.stepUuid).toBe('s7');
    for (const id of ['s7', 's8', 's9']) y.steps.find((s) => s.uuid === id).status = 'done';
    // 6. Every step done is not finished: the outcome is unverified.
    expect(state().completion.state).toBe('outcome_unverified');
    expect(state().nextAction).toBeNull();
    expect(state().unblock).toBe('Go through the closeout checklist.');
    // 7. The owner confirms each check; only then is it ready to close, and verified once closed.
    y.doneWhenConfirmed = ex.getProjectCloseoutSummary(y).criteria.map((c) => c.text);
    expect(state().completion.state).toBe('ready_for_confirmation');
    Object.assign(y, { status: 'done', effectiveStatus: 'done', outcomeConfirmedAt: day(0) });
    expect(ex.getCompletionReadiness(y).state).toBe('verified_complete');
  });
});
