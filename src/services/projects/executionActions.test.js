// The projects execution actions (services/actions/registry.js): update_project's
// plan fields, update_project_step, schedule_project_work, record_project_session,
// put_project_session_on_calendar and close_out_project.
jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./index', () => ({
  findByTitle: jest.fn(), stepsOf: jest.fn(), itemsOf: jest.fn(), create: jest.fn(), update: jest.fn(),
  addStep: jest.fn(), updateStep: jest.fn(), addLink: jest.fn(), addItem: jest.fn(), updateItem: jest.fn(),
  addStepDependency: jest.fn(), removeStepDependency: jest.fn(), withTx: jest.fn((fn) => fn({})),
  createSession: jest.fn(), updateSession: jest.fn(), openSessionsOf: jest.fn(), findSession: jest.fn(), setSessionCalendarEvent: jest.fn(),
}));
jest.mock('./entries', () => ({ add: jest.fn() }));
jest.mock('../connectors/googleCalendar', () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock('../lookRequests', () => ({ create: jest.fn() }));
jest.mock('../codeAgents', () => ({ REPOS: { core_api: {} }, mayUse: jest.fn(), openInvestigation: jest.fn(), openFix: jest.fn(), parseRef: () => null }));
jest.mock('../credentials', () => ({ list: jest.fn() }));
jest.mock('../consent', () => ({ hasConsentForProfile: jest.fn() }));
jest.mock('../family', () => ({ getFamilyForProfile: jest.fn() }));
jest.mock('../../security/access', () => ({ assertModelAccess: jest.fn() }));
jest.mock('../memory', () => ({ CATEGORIES: new Set(['other']), upsertMemoryForProfile: jest.fn() }));

const store = require('./index');
const journal = require('./entries');
const calendar = require('../connectors/googleCalendar');
const registry = require('../actions/registry');

const ctx = { profileId: 1 };
const SIDE_YARD = { id: 7, uuid: 'p1', title: 'Side yard', status: 'planning', done_when: 'Fence is stable\nGate latches' };
const steps = [
  { uuid: 's2', title: 'Measure and mark the fence line', status: 'todo', effort_minutes: 45, acceptance_criteria: null },
  { uuid: 's3', title: 'Mark the gate opening', status: 'todo', effort_minutes: null, acceptance_criteria: 'Opening is 4 ft clear' },
  { uuid: 's6', title: 'Verify the wall attachment', status: 'blocked', effort_minutes: null, acceptance_criteria: null },
];
const later = (days, hour = 13) => { const d = new Date(Date.now() + days * 86_400_000); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

beforeEach(() => {
  jest.resetAllMocks();
  store.findByTitle.mockResolvedValue(SIDE_YARD);
  store.stepsOf.mockResolvedValue([steps]);
  store.withTx.mockImplementation((fn) => fn({}));
});

describe('approval boundaries', () => {
  it('never lets a closeout or a calendar write be standing-approved', () => {
    expect(registry.get('close_out_project')).toMatchObject({ standing: false, provider: null });
    expect(registry.get('put_project_session_on_calendar')).toMatchObject({ standing: false, provider: 'google_calendar', consentType: 'action_authority', direct: true });
  });

  it('keeps scheduling off the calendar: it has no provider and never calls one', async () => {
    const a = registry.get('schedule_project_work');
    expect(a.provider).toBeNull();
    store.createSession.mockResolvedValue({ uuid: 'w1' });
    const p = await a.normalize({ project: 'side yard', work_step: 'fence line', session_start: later(3) }, ctx);
    await a.execute(1, p);
    expect(calendar.createEvent).not.toHaveBeenCalled();
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
  });

  it('refuses to mark a project with criteria done through update_project', async () => {
    await expect(registry.get('update_project').normalize({ project: 'side yard', project_status: 'done' }, ctx))
      .rejects.toMatchObject({ code: 'invalid_action_params', message: expect.stringMatching(/close_out_project/) });
  });
});

describe('update_project plan fields (0096/0097)', () => {
  const a = () => registry.get('update_project');

  it('normalizes budget, pin, revision and done-when, and says them back', async () => {
    const p = await a().normalize({ project: 'side yard', project_budget: '$3,200', project_budget_ceiling: 4200, project_pin: 'on', project_revision: 'v1.3', project_note: 'Gate moved 6 in', project_done_when: '- Fence is stable\n- Gate latches\n- Cans roll through' }, ctx);
    expect(p).toMatchObject({ project_budget: 3200, project_budget_ceiling: 4200, project_pin: true, project_revision: '1.3', project_done_when: 'Fence is stable\nGate latches\nCans roll through' });
    expect(a().summarize(p)).toMatch(/working budget \$3200; approval ceiling \$4200; move it to the front of the line/);
    await a().execute(1, p);
    expect(store.update).toHaveBeenCalledWith(1, 'p1', { doneWhen: 'Fence is stable\nGate latches\nCans roll through', revision: '1.3', budget: { working: 3200, ceiling: 4200 }, pinned: true });
    expect(journal.add).toHaveBeenCalledWith(1, 'p1', { type: 'decision', body: 'v1.3 — Gate moved 6 in' }, { source: 'chat' });
  });

  it('refuses a budget above its ceiling, and adds and verifies specs', async () => {
    await expect(a().normalize({ project: 'side yard', project_budget: 5000, project_budget_ceiling: 4200 }, ctx)).rejects.toThrow(/above the approval ceiling/);
    store.itemsOf.mockResolvedValue([[{ uuid: 'i1', label: 'Gate location', kind: 'spec', status: 'pending' }]]);
    const p = await a().normalize({ project: 'side yard', project_item_confirmed: 'gate location', project_item: 'Post spacing', project_item_value: '6 ft' }, ctx);
    await a().execute(1, p);
    expect(store.updateItem).toHaveBeenCalledWith(1, 'p1', 'i1', { status: 'confirmed' });
    expect(store.addItem).toHaveBeenCalledWith(1, 'p1', expect.objectContaining({ kind: 'spec', label: 'Post spacing', value: '6 ft', status: 'pending' }));
  });

  it('says that ticking off a step with acceptance criteria confirms them', async () => {
    const p = await a().normalize({ project: 'side yard', project_step_done: 'gate opening' }, ctx);
    expect(a().summarize(p)).toBe('"Side yard": tick off "Mark the gate opening" (you\'re confirming: Opening is 4 ft clear)');
  });
});

describe('update_project_step', () => {
  const a = () => registry.get('update_project_step');

  it('records a blocker with who, when to look again and what clears it', async () => {
    const p = await a().normalize({ project: 'side yard', step: 'wall attachment', step_status: 'blocked', step_blocked_on: 'house framing check', step_waiting_on: 'the contractor', step_review_on: later(3).slice(0, 10), step_unblock_action: 'Call Sam' }, ctx);
    expect(a().summarize(p)).toMatch(/mark it blocked on house framing check, waiting on the contractor; look again on \d{4}-\d{2}-\d{2}; what clears it: Call Sam/);
    await a().execute(1, p);
    expect(store.updateStep).toHaveBeenCalledWith(1, 'p1', 's6', expect.objectContaining({ status: 'blocked', blockedOn: 'house framing check', waitingOnActor: 'the contractor', unblockAction: 'Call Sam', reviewAt: expect.stringMatching(/T12:00:00Z$/) }), { db: {} });
  });

  it('refuses follow-up fields on a step that is not blocked, and a review date in the past', async () => {
    await expect(a().normalize({ project: 'side yard', step: 'fence line', step_waiting_on: 'Sam' }, ctx)).rejects.toThrow(/only goes with a blocked step/);
    await expect(a().normalize({ project: 'side yard', step: 'wall', step_review_on: '2020-01-01' }, ctx)).rejects.toThrow(/in the past/);
  });

  it('sets prerequisites from titles in the same project, never itself', async () => {
    const p = await a().normalize({ project: 'side yard', step: 'gate opening', step_needs_first: ['fence line'] }, ctx);
    expect(p.step_needs).toEqual([{ uuid: 's2', title: 'Measure and mark the fence line' }]);
    await a().execute(1, p);
    expect(store.addStepDependency).toHaveBeenCalledWith(1, 'p1', 's3', 's2', { db: {} });
    await expect(a().normalize({ project: 'side yard', step: 'gate opening', step_needs_first: ['gate opening'] }, ctx)).rejects.toThrow(/can't need itself/);
    await expect(a().normalize({ project: 'side yard', step: 'gate opening', step_needs_first: ['the roof'] }, ctx)).rejects.toThrow(/has no step called/);
  });

  it('adds a new step with its effort and prerequisites in one go', async () => {
    store.addStep.mockResolvedValue({ uuid: 'new' });
    const p = await a().normalize({ project: 'side yard', step: 'Buy post anchors', step_is_new: true, step_effort_minutes: 40, step_needs_first: ['fence line'] }, ctx);
    await a().execute(1, p);
    expect(store.addStep).toHaveBeenCalledWith(1, 'p1', { title: 'Buy post anchors', effortMinutes: 40, dependsOn: ['s2'] }, { db: {} });
  });

  it('puts a step and others under a phase, or takes it out, and says so', async () => {
    const p = await a().normalize({ project: 'side yard', step: 'fence line', step_phase: 'Layout', step_also: ['gate opening', 'fence line'] }, ctx);
    expect(p).toMatchObject({ step_phase: 'Layout', step_also: [{ uuid: 's3', title: 'Mark the gate opening' }] });
    expect(a().summarize(p)).toBe('"Side yard": "Measure and mark the fence line": put it and "Mark the gate opening" under "Layout"');
    await a().execute(1, p);
    expect(store.updateStep).toHaveBeenCalledWith(1, 'p1', 's2', { phase: 'Layout' }, { db: {} });
    expect(store.updateStep).toHaveBeenCalledWith(1, 'p1', 's3', { phase: 'Layout' }, { db: {} });
    const out = await a().normalize({ project: 'side yard', step: 'fence line', step_phase: 'none' }, ctx);
    expect(out.step_phase).toBeNull();
    expect(a().summarize(out)).toMatch(/take it out of its phase/);
    await expect(a().normalize({ project: 'side yard', step: 'fence line', step_also: ['gate opening'] }, ctx)).rejects.toThrow(/only goes with step_phase/);
  });
});

describe('schedule_project_work and record_project_session', () => {
  const schedule = () => registry.get('schedule_project_work');
  const record = () => registry.get('record_project_session');

  it("defaults to the step's effort and refuses a time with no zone, or in the past", async () => {
    const p = await schedule().normalize({ project: 'side yard', work_step: 'fence line', session_start: '2026-12-05T09:00:00', time_zone: 'America/New_York' }, ctx);
    expect(p).toMatchObject({ session_minutes: 45, step_uuid: 's2', session_start: '2026-12-05T14:00:00.000Z' });
    expect(schedule().summarize(p)).toMatch(/^Set aside .*45 min for "Measure and mark the fence line" \(Side yard\)$/);
    await expect(schedule().normalize({ project: 'side yard', session_start: '2026-12-05T09:00:00' }, ctx)).rejects.toThrow(/UTC offset/);
    await expect(schedule().normalize({ project: 'side yard', session_start: '2020-01-01T09:00:00Z' }, ctx)).rejects.toThrow(/in the past/);
  });

  it('reschedules the same session, and says its calendar event has not moved', async () => {
    store.stepsOf.mockResolvedValue([steps.map((s) => ({ ...s, effort_minutes: null }))]);
    store.openSessionsOf.mockResolvedValue([[{ uuid: 'w1', planned_start: '2026-12-05 14:00:00', planned_duration_minutes: 45, step_uuid: 's2', step_title: 'Measure and mark the fence line', calendar_event_id: 'evt' }]]);
    const p = await schedule().normalize({ project: 'side yard', session_start: '2026-12-12T14:00:00Z', session_moving_from: '2026-12-05' }, ctx);
    expect(p).toMatchObject({ session_uuid: 'w1', on_calendar: true, step_uuid: 's2' });
    expect(schedule().summarize(p)).toMatch(/calendar event stays put/);
    await schedule().execute(1, p);
    expect(store.updateSession).toHaveBeenCalledWith(1, 'p1', 'w1', { plannedStart: '2026-12-12T14:00:00.000Z', plannedMinutes: 45 });
    expect(store.createSession).not.toHaveBeenCalled();
  });

  it('logs a session without completing its step unless they said the step is done', async () => {
    store.openSessionsOf.mockResolvedValue([[{ uuid: 'w0', planned_start: '2026-10-20 13:00:00', step_uuid: 's2', step_title: 'Measure and mark the fence line' }]]);
    const p = await record().normalize({ project: 'side yard', session_outcome: 'completed', session_actual_minutes: 50, session_made_progress: true }, ctx);
    await record().execute(1, p);
    expect(store.updateSession).toHaveBeenCalledWith(1, 'p1', 'w0', { status: 'completed', actualMinutes: 50, madeProgress: true });
    expect(store.updateStep).not.toHaveBeenCalled();
    const done = await record().normalize({ project: 'side yard', session_outcome: 'completed', session_step_done: true }, ctx);
    expect(record().summarize(done)).toMatch(/and mark "Measure and mark the fence line" itself done/);
    await record().execute(1, done);
    expect(store.updateStep).toHaveBeenCalledWith(1, 'p1', 's2', { status: 'done' });
  });
});

describe('put_project_session_on_calendar', () => {
  const a = () => registry.get('put_project_session_on_calendar');
  const row = { uuid: 'w1', project_uuid: 'p1', project_title: 'Side yard', step_title: 'Mark the fence line', status: 'planned', planned_start: '2026-11-01 13:00:00', planned_duration_minutes: 45, calendar_event_id: null, calendar_start: null };

  it('adds one event for the session and remembers which it is', async () => {
    store.findSession.mockResolvedValue(row);
    calendar.createEvent.mockResolvedValue({ ref: 'evt-1', html_link: 'https://calendar' });
    const p = await a().normalize({ session_uuid: 'w1' }, ctx);
    expect(p).toMatchObject({ title: 'Mark the fence line — Side yard', start: '2026-11-01T13:00:00.000Z', end: '2026-11-01T13:45:00.000Z' });
    await a().execute(1, p);
    expect(store.setSessionCalendarEvent).toHaveBeenCalledWith(1, 'w1', 'evt-1', '2026-11-01T13:00:00.000Z');
  });

  it('refuses a second event for a session already on the calendar at that time', async () => {
    store.findSession.mockResolvedValue({ ...row, calendar_event_id: 'evt-1', calendar_start: '2026-11-01 13:00:00' });
    await expect(a().normalize({ session_uuid: 'w1' }, ctx)).rejects.toThrow(/already on the calendar/);
  });

  it('moves a rescheduled session by replacing its event, delete first', async () => {
    store.findSession.mockResolvedValue({ ...row, planned_start: '2026-11-08 13:00:00', calendar_event_id: 'evt-1', calendar_start: '2026-11-01 13:00:00' });
    calendar.createEvent.mockResolvedValue({ ref: 'evt-2' });
    const p = await a().normalize({ session_uuid: 'w1' }, ctx);
    expect(a().summarize(p)).toMatch(/^Move "Mark the fence line — Side yard" on your calendar/);
    await a().execute(1, p);
    expect(calendar.deleteEvent.mock.invocationCallOrder[0]).toBeLessThan(calendar.createEvent.mock.invocationCallOrder[0]);
    expect(store.setSessionCalendarEvent).toHaveBeenLastCalledWith(1, 'w1', 'evt-2', '2026-11-08T13:00:00.000Z');
  });

  it('leaves the session as it was when the calendar is unavailable', async () => {
    store.findSession.mockResolvedValue(row);
    calendar.createEvent.mockRejectedValue(new Error('Google Calendar needs reconnecting'));
    const p = await a().normalize({ session_uuid: 'w1' }, ctx);
    await expect(a().execute(1, p)).rejects.toThrow(/reconnecting/);
    expect(store.setSessionCalendarEvent).not.toHaveBeenCalled();
    expect(store.updateSession).not.toHaveBeenCalled();
  });
});

describe('close_out_project', () => {
  const a = () => registry.get('close_out_project');

  it('refuses while steps are open', async () => {
    await expect(a().normalize({ project: 'side yard' }, ctx)).rejects.toThrow(/still has 3 open steps/);
  });

  it('lists every check the person is confirming, then closes with the outcome confirmed', async () => {
    store.stepsOf.mockResolvedValue([steps.map((s) => ({ ...s, status: 'done' }))]);
    const p = await a().normalize({ project: 'side yard', project_note: 'Cans roll right through' }, ctx);
    expect(a().summarize(p)).toBe('Close out "Side yard" — you\'re confirming: ✓ Fence is stable; ✓ Gate latches');
    await a().execute(1, p);
    expect(store.update).toHaveBeenCalledWith(1, 'p1', { status: 'done', outcomeConfirmed: true });
    expect(journal.add).toHaveBeenCalledWith(1, 'p1', { type: 'note', body: 'Cans roll right through' }, { source: 'chat' });
  });
});
