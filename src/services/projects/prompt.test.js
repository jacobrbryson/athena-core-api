// The projects chat block (services/projects/prompt.js): compact execution
// summaries, not the whole graph.
jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./index', () => ({ getAll: jest.fn() }));
jest.mock('./bindings', () => ({ read: jest.fn(async () => []) }));
jest.mock('../../controllers/propertyIssues', () => ({ openIssues: jest.fn(async () => []) }));
jest.mock('../../controllers/propertyVehicles', () => ({ promptVehicles: jest.fn(async () => []) }));

const projects = require('./index');
const { promptBlock } = require('./prompt');

const step = (uuid, title, extra = {}) => ({ uuid, title, ordinal: Number(uuid.slice(1)), status: 'todo', who: 'me', dependsOn: [], detail: null, effortMinutes: null, indoor: null, dueOn: null, ...extra });
const base = {
  status: 'active', effectiveStatus: 'active', priority: 4, primaryArea: 'home', kind: null, serves: [], conditions: [], items: [], bindings: [],
  pinnedAt: null, waitingOn: null, hardDeadline: null, budget: {}, progress: { steps: { done: 1, total: 4 } },
};

it('says what is ready and why, what is blocked and when to look again, the next session and the done-when checks', async () => {
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
  projects.getAll.mockResolvedValue({
    links: [], concerns: [], charters: [],
    projects: [{
      ...base, uuid: 'p', title: 'Side yard', doneWhen: 'Fence is stable\nGate latches', doneWhenConfirmed: [],
      steps: [
        step('s1', 'Layout', { status: 'done', phase: 'Design' }),
        step('s2', 'Mark the fence line', { dependsOn: ['s1'], effortMinutes: 45, phase: 'Design' }),
        step('s3', 'Wall attachment', { status: 'blocked', blockedOn: 'framing check', waitingOnActor: 'the contractor', reviewAt: new Date(Date.now() - 86_400_000).toISOString() }),
        step('s4', 'Order lumber', { status: 'blocked', blockedOn: 'a quote' }),
      ],
      sessions: [{ uuid: 'w', stepUuid: 's2', plannedStart: soon, plannedMinutes: 45, status: 'planned', calendarEventId: null }],
    }],
  });
  const block = await promptBlock(1);
  expect(block).toMatch(/ready next: "Mark the fence line" in Design \(everything it needs is done \("Layout"\), about 45 min\)/);
  expect(block).toMatch(/phases: Design 1\/2/);
  expect(block).toMatch(/blocked: "Wall attachment" on framing check, waiting on the contractor — check-back was due .* UTC: Check with the contractor about framing check\./);
  expect(block).toMatch(/blocked: "Order lumber" on a quote — no check-back date yet; ask when to look again/);
  expect(block).toMatch(/next session .* UTC, 45 min on "Mark the fence line" \(not on the calendar\)/);
  expect(block).toMatch(/done when: Fence is stable; Gate latches/);
  expect(block).toMatch(/close_out_project only after they confirm each one/);
  expect(block).not.toMatch(/dependsOn|stepUuid/);
});

it('says when every step is done but the outcome is unconfirmed', async () => {
  projects.getAll.mockResolvedValue({
    links: [], concerns: [], charters: [],
    projects: [{ ...base, uuid: 'p', title: 'Porch', doneWhen: 'Steps are level', doneWhenConfirmed: [], steps: [step('s1', 'Set steps', { status: 'done' })], sessions: [] }],
  });
  const block = await promptBlock(1);
  expect(block).toMatch(/every step done; 1 of 1 "done when" checks unconfirmed/);
  expect(block).toMatch(/nothing ready: Every step is done; 1 check of the outcome still to confirm\. To unstick: Go through the closeout checklist\./);
});
