// The execution writes in services/projects/index.js, against a mocked database:
// step dependencies, blocker fields, work sessions, outcome confirmation, and the
// full-graph snapshot staying compatible.
jest.mock('../../helpers/db', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../../helpers/actor', () => ({ requireAdultActor: jest.fn(async () => ({ profileId: 1 })) }));
jest.mock('../rightNow', () => ({ invalidate: jest.fn(async () => {}) }));

const pool = require('../../helpers/db');
const projects = require('./index');

/** A connection whose answers are picked by SQL prefix; everything it was asked is in conn.query.mock.calls. */
function connection(routes) {
  const conn = { beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(async () => {}), release: jest.fn(), query: jest.fn() };
  conn.query.mockImplementation(async (sql, args) => {
    for (const [prefix, answer] of routes) if (sql.replace(/\s+/g, ' ').trim().startsWith(prefix)) return typeof answer === 'function' ? answer(sql, args) : answer;
    return [{ affectedRows: 1, insertId: 99 }];
  });
  pool.getConnection.mockResolvedValue(conn);
  return conn;
}
const sqls = (conn, prefix) => conn.query.mock.calls.filter(([sql]) => sql.replace(/\s+/g, ' ').trim().startsWith(prefix));

beforeEach(() => jest.resetAllMocks());

const STEP_ROW = { id: 12, pid: 7, uuid: 's5', title: 'Coordinate posts', status: 'todo', who: 'me', ordinal: 4, review_at: null, acceptance_criteria: null, waiting_on_actor: null, unblock_action: null };
const PROJECT_STEPS = [
  { id: 10, uuid: 's3', title: 'Mark gate' }, { id: 11, uuid: 's4', title: 'Finalize extension' },
  { id: 12, uuid: 's5', title: 'Coordinate posts' }, { id: 13, uuid: 's7', title: 'Pour' },
];

describe('step dependencies', () => {
  const routes = (edges = []) => [
    ['SELECT s.*, p.id AS pid', [[STEP_ROW]]],
    ['SELECT id, uuid, title FROM athena_project_step', [PROJECT_STEPS]],
    ['SELECT step_id, depends_on_step_id', [edges]],
    ['SELECT s.uuid FROM athena_project_step_dependency', [[]]],
  ];

  it('supports several prerequisites, writes each edge once, and keeps them in the project', async () => {
    const conn = connection(routes());
    await projects.updateStep(1, 'side-yard', 's5', { dependsOn: ['s3', 's4', 's3'] });
    const inserts = sqls(conn, 'INSERT INTO athena_project_step_dependency');
    expect(inserts.map(([, a]) => a)).toEqual([[7, 12, 10], [7, 12, 11]]);
    expect(sqls(conn, 'DELETE FROM athena_project_step_dependency')).toHaveLength(1);
  });

  it('rejects a cycle, a self-dependency and a step from another project', async () => {
    // s7 already needs s5; s5 needing s7 would loop.
    connection(routes([{ step_id: 13, depends_on_step_id: 12 }]));
    await expect(projects.updateStep(1, 'side-yard', 's5', { dependsOn: ['s7'] })).rejects.toThrow(/wait on each other/);
    connection(routes());
    await expect(projects.updateStep(1, 'side-yard', 's5', { dependsOn: ['s5'] })).rejects.toThrow(/can't need itself/);
    connection(routes());
    await expect(projects.updateStep(1, 'side-yard', 's5', { dependsOn: ['someone-elses-step'] })).rejects.toThrow(/same project/);
  });

  it("can't reach a step of another person's project at all", async () => {
    connection([['SELECT s.*, p.id AS pid', [[]]]]);
    await expect(projects.addStepDependency(2, 'side-yard', 's5', 's3')).rejects.toMatchObject({ status: 404 });
    const [sql, args] = pool.getConnection.mock.results.length ? (await pool.getConnection.mock.results[0].value).query.mock.calls[0] : [];
    expect(sql).toMatch(/p\.profile_id = \?/);
    expect(args[0]).toBe(2);
  });
});

describe('blocker fields', () => {
  it('records what, who, when and what clears it, and clears all four on unblock', async () => {
    let conn = connection([['SELECT s.*, p.id AS pid', [[STEP_ROW]]]]);
    await projects.updateStep(1, 'p', 's5', { status: 'blocked', blockedOn: 'permit response', waitingOnActor: 'the county', reviewAt: '2026-10-30', unblockAction: 'Call the permit office' });
    let [sql, args] = sqls(conn, 'UPDATE athena_project_step')[0];
    expect(sql).toMatch(/waiting_on_actor = \?, review_at = \?, unblock_action = \?/);
    expect(args).toEqual(expect.arrayContaining(['blocked', 'permit response', 'the county', '2026-10-30 12:00:00', 'Call the permit office']));
    conn = connection([['SELECT s.*, p.id AS pid', [[{ ...STEP_ROW, status: 'blocked', blocked_on: 'permit response', waiting_on_actor: 'the county', review_at: '2026-10-30 12:00:00' }]]]]);
    await projects.updateStep(1, 'p', 's5', { status: 'todo' });
    [sql, args] = sqls(conn, 'UPDATE athena_project_step')[0];
    expect(args.slice(2, 5)).toEqual(['todo', 'me', null]);
    expect(args.filter((a) => a === null).length).toBeGreaterThanOrEqual(4);
  });

  it('writes a phase label and clears it with null, without touching readiness fields', async () => {
    const conn = connection([['SELECT s.*, p.id AS pid', [[{ ...STEP_ROW, phase: null }]]]]);
    await projects.updateStep(1, 'p', 's5', { phase: '  Concrete and Foundations ' });
    const [sql, args] = sqls(conn, 'UPDATE athena_project_step')[0];
    expect(sql).toMatch(/phase = \?/);
    expect(args).toContain('Concrete and Foundations');
    expect(sqls(conn, 'INSERT INTO athena_project_step_dependency')).toHaveLength(0);
  });

  it('keeps working on a database without 0097: new columns only when the row has them or the patch names them', async () => {
    const legacy = { id: 12, pid: 7, uuid: 's5', title: 'Coordinate posts', status: 'todo', who: 'me', ordinal: 4 };
    const conn = connection([['SELECT s.*, p.id AS pid', [[legacy]]]]);
    await projects.updateStep(1, 'p', 's5', { status: 'done' });
    expect(sqls(conn, 'UPDATE athena_project_step')[0][0]).not.toMatch(/review_at|acceptance_criteria/);
    const add = connection([['SELECT * FROM athena_project WHERE', [[{ id: 7, uuid: 'p' }]]], ['SELECT COUNT(*) AS n, COALESCE', [[{ n: 0, last: 2 }]]]]);
    await projects.addStep(1, 'p', { title: 'Plants' });
    expect(sqls(add, 'INSERT INTO athena_project_step')[0][0]).not.toMatch(/review_at|acceptance_criteria/);
  });
});

describe('work sessions', () => {
  const projectRow = [['SELECT id, status FROM athena_project', [[{ id: 7, status: 'active' }]]]];

  it('creates a session for a step of the same project, and refuses another project\'s step', async () => {
    const conn = connection([...projectRow,
      ['SELECT id FROM athena_project_step', [[{ id: 12 }]]],
      ['SELECT COUNT(*) AS n FROM athena_project_work_session', [[{ n: 0 }]]],
      ['SELECT uuid FROM athena_project_work_session', [[]]]]);
    const { uuid } = await projects.createSession(1, 'p', { stepUuid: 's2', plannedStart: '2026-11-01T09:00:00-04:00', plannedMinutes: 45 });
    const [, args] = sqls(conn, 'INSERT INTO athena_project_work_session')[0];
    expect(args).toEqual([uuid, 1, 7, 12, '2026-11-01 13:00:00', 45, null, 'planned', null, null]);
    connection([...projectRow, ['SELECT id FROM athena_project_step', [[]]]]);
    await expect(projects.createSession(1, 'p', { stepUuid: 'elsewhere', plannedStart: '2026-11-01', plannedMinutes: 45 })).rejects.toThrow(/isn't part of this project/);
  });

  it('refuses booking the same work twice over the same time', async () => {
    connection([...projectRow,
      ['SELECT COUNT(*) AS n FROM athena_project_work_session', [[{ n: 1 }]]],
      ['SELECT uuid FROM athena_project_work_session', [[{ uuid: 'w1' }]]]]);
    await expect(projects.createSession(1, 'p', { plannedStart: '2026-11-01T13:00:00Z', plannedMinutes: 60 }))
      .rejects.toMatchObject({ code: 'duplicate_session', sessionUuid: 'w1' });
  });

  const session = { id: 40, pid: 7, uuid: 'w1', step_id: 12, step_uuid: 's2', planned_start: '2026-11-01 13:00:00', planned_duration_minutes: 45, status: 'planned', calendar_event_id: 'evt-1', calendar_start: '2026-11-01 13:00:00' };

  it('reschedules in place: same row, same uuid, calendar event left for an approved action', async () => {
    const conn = connection([['SELECT w.*, p.id AS pid', [[session]]], ['SELECT uuid FROM athena_project_work_session', [[]]]]);
    const out = await projects.updateSession(1, 'p', 'w1', { plannedStart: '2026-11-08T13:00:00Z' });
    expect(out).toEqual({ uuid: 'w1', moved: true, calendarEventId: 'evt-1' });
    const [sql, args] = sqls(conn, 'UPDATE athena_project_work_session')[0];
    expect(sql).not.toMatch(/calendar_event_id/);
    expect(args[1]).toBe('2026-11-08 13:00:00');
    expect(args[args.length - 1]).toBe(40);
  });

  it('completes a session without completing its step', async () => {
    const conn = connection([['SELECT w.*, p.id AS pid', [[session]]]]);
    await projects.updateSession(1, 'p', 'w1', { status: 'completed', actualMinutes: 50, madeProgress: true });
    expect(sqls(conn, 'UPDATE athena_project_step')).toHaveLength(0);
    expect(sqls(conn, 'UPDATE athena_project SET last_progress_at')).toHaveLength(1);
    expect(sqls(conn, 'UPDATE athena_project_work_session')[0][1]).toEqual(expect.arrayContaining(['completed', 50, 1]));
  });
});

describe('outcome confirmation', () => {
  const row = { id: 7, uuid: 'p', title: 'Side yard', status: 'active', priority: 4, conditions: '[]', serves: '[]', visibility: 'private',
    done_when: 'Fence is stable\nGate latches', done_when_confirmed: '[]', outcome_confirmed_at: null };
  const routes = [['SELECT * FROM athena_project', [[row]]], ['SELECT area', [[]]]];

  it('refuses to close a project with criteria unless the outcome is confirmed', async () => {
    connection(routes);
    await expect(projects.update(1, 'p', { status: 'done' })).rejects.toMatchObject({ status: 400, code: 'outcome_unconfirmed' });
  });

  it('closing with confirmation ticks every criterion and records when', async () => {
    const conn = connection(routes);
    await projects.update(1, 'p', { status: 'done', outcomeConfirmed: true });
    const [sql, args] = sqls(conn, 'UPDATE athena_project SET')[0];
    expect(sql).toMatch(/done_when_confirmed = \?/);
    expect(sql).toMatch(/outcome_confirmed_at = \?/);
    expect(args).toContain(JSON.stringify(['Fence is stable', 'Gate latches']));
    expect(args.some((a) => a instanceof Date)).toBe(true);
  });

  it('leaves a legacy project without criteria closing exactly as before', async () => {
    const conn = connection([['SELECT * FROM athena_project', [[{ ...row, done_when: null }]]], ['SELECT area', [[]]]]);
    await projects.update(1, 'p', { status: 'done' });
    expect(sqls(conn, 'UPDATE athena_project SET')).toHaveLength(1);
  });

  it('un-ticks a criterion that was reworded', async () => {
    const conn = connection([['SELECT * FROM athena_project', [[{ ...row, done_when_confirmed: '["Fence is stable"]' }]]], ['SELECT area', [[]]]]);
    await projects.update(1, 'p', { doneWhen: 'Fence is stable and 6 ft\nGate latches' });
    expect(sqls(conn, 'UPDATE athena_project SET')[0][1]).toContain('[]');
  });
});

describe('the full graph', () => {
  const projectRow = { id: 7, uuid: 'p', title: 'Side yard', status: 'active', priority: 4, conditions: '[]', serves: '[]', visibility: 'private', last_progress_at: null };
  const stepRows = [
    { id: 10, project_id: 7, uuid: 's1', ordinal: 0, title: 'Layout', status: 'done', who: 'me' },
    { id: 11, project_id: 7, uuid: 's2', ordinal: 1, title: 'Mark fence line', status: 'todo', who: 'me', effort_minutes: 45 },
  ];
  function db({ withExecutionTables }) {
    pool.query.mockImplementation(async (sql) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT * FROM athena_project WHERE')) return [[projectRow]];
      if (s.startsWith('SELECT * FROM athena_project_step')) return [stepRows];
      if (s.includes('athena_project_step_dependency') || s.includes('athena_project_work_session') || s.includes('athena_project_pref')) {
        if (!withExecutionTables) throw new Error("ER_NO_SUCH_TABLE");
        if (s.includes('dependency')) return [[{ step_id: 11, depends_on_step_id: 10 }]];
        if (s.includes('work_session')) return [[{ uuid: 'w1', project_id: 7, step_id: 11, planned_start: '2099-11-01 13:00:00', planned_duration_minutes: 45, status: 'planned' }]];
        return [[]];
      }
      return [[]];
    });
  }

  it('carries dependencies and sessions when 0097 is applied', async () => {
    db({ withExecutionTables: true });
    const all = await projects.getAll(1);
    expect(all.projects[0].steps[1].dependsOn).toEqual(['s1']);
    expect(all.projects[0].sessions[0]).toMatchObject({ uuid: 'w1', stepUuid: 's2', plannedStart: '2099-11-01T13:00:00.000Z' });
    expect(all.prefs).toEqual({ focusLimit: 3, preferFinishing: true });
  });

  it('still returns every project, step and field it did before 0097', async () => {
    db({ withExecutionTables: false });
    const all = await projects.getAll(1);
    expect(all.projects[0]).toMatchObject({ uuid: 'p', title: 'Side yard', sessions: [] });
    expect(all.projects[0].steps.map((s) => [s.uuid, s.dependsOn])).toEqual([['s1', []], ['s2', []]]);
  });

  it('answers a write with the whole graph plus the derived execution state', async () => {
    db({ withExecutionTables: true });
    const c = require('../../controllers/projects');
    const res = { set: jest.fn(), status: jest.fn(() => res), json: jest.fn() };
    await c.list({ params: {}, body: {} }, res);
    const body = res.json.mock.calls[0][0];
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['projects', 'links', 'concerns', 'charters', 'prefs', 'execution']));
    expect(body.projects[0].execution.nextAction).toMatchObject({ stepUuid: 's2', title: 'Mark fence line' });
    expect(body.projects[0].execution.preparation.work.title).toBe('Mark fence line');
    expect(body.projects[0].completion.state).toBe('work_remaining');
    expect(body.execution.metrics).toMatchObject({ activeProjects: 1, activeWithNextAction: 1 });
    expect(body.projects[0].rank).not.toBeNull();
  });
});
