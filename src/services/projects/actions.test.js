// The add_project / update_project actions (services/actions/registry.js).
jest.mock('../../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./index', () => ({
  findByTitle: jest.fn(), stepsOf: jest.fn(), create: jest.fn(), update: jest.fn(),
  addStep: jest.fn(), updateStep: jest.fn(), addLink: jest.fn(),
}));
jest.mock('./entries', () => ({ add: jest.fn() }));
// The registry loads every action's service; the heavy ones are stubbed as in actions/actions.test.js.
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
const registry = require('../actions/registry');

const add = registry.get('add_project');
const update = registry.get('update_project');
const ctx = { profileId: 1 };

beforeEach(() => jest.resetAllMocks());

describe('add_project', () => {
  it('normalizes a new project and names the program it joins', async () => {
    store.findByTitle.mockResolvedValue({ uuid: 'prog', title: 'Winter comfort' });
    const p = await add.normalize({ project_title: 'Insulate the attic', project_area: 'Home', project_priority: 4, project_part_of: 'winter comfort', smuggled: 'x' }, ctx);
    expect(p).toEqual({ project_title: 'Insulate the attic', project_area: 'home', project_priority: 4, part_of_uuid: 'prog', part_of_title: 'Winter comfort' });
    expect(add.summarize(p)).toBe('Start the project "Insulate the attic" as part of "Winter comfort"');
  });

  it('refuses a bad area, priority or deadline', async () => {
    await expect(add.normalize({ project_title: 'x', project_area: 'garage' }, ctx)).rejects.toMatchObject({ code: 'invalid_action_params' });
    await expect(add.normalize({ project_title: 'x', project_priority: 9 }, ctx)).rejects.toThrow(/1 \(low\) to 5/);
    await expect(add.normalize({ project_title: 'x', project_deadline: 'soon' }, ctx)).rejects.toThrow(/not a date/);
    await expect(add.normalize({}, ctx)).rejects.toThrow(/needs a title/);
  });

  it('creates it as an idea, from chat, and links it', async () => {
    store.create.mockResolvedValue({ uuid: 'new' });
    store.addLink.mockResolvedValue(true);
    await add.execute(1, { project_title: 'T', project_area: 'health', project_priority: 3, part_of_uuid: 'prog' });
    expect(store.create).toHaveBeenCalledWith(1, expect.objectContaining({ title: 'T', status: 'idea', primaryArea: 'health' }), { source: 'chat' });
    expect(store.addLink).toHaveBeenCalledWith(1, 'new', { relation: 'contributes_to', to: 'prog' });
  });
});

describe('update_project', () => {
  beforeEach(() => store.findByTitle.mockResolvedValue({ id: 5, uuid: 'p1', title: 'Porch steps' }));

  it('resolves the project and the finished step, and says it all back', async () => {
    store.stepsOf.mockResolvedValue([[{ uuid: 's1', title: 'Finish the bottom step', status: 'todo' }, { uuid: 's2', title: 'Plants', status: 'todo' }]]);
    const p = await update.normalize({ project: 'porch', project_step_done: 'bottom step', project_step: 'Accent lighting', project_status: 'active' }, ctx);
    expect(p).toMatchObject({ project_uuid: 'p1', step_done_uuid: 's1', project_step: 'Accent lighting', project_status: 'active' });
    expect(update.summarize(p)).toBe('"Porch steps": mark it started; tick off "Finish the bottom step"; add the step "Accent lighting"');
  });

  it('refuses an ambiguous step, an unknown status, and an update that changes nothing', async () => {
    store.stepsOf.mockResolvedValue([[{ uuid: 'a', title: 'Paint trim' }, { uuid: 'b', title: 'Paint walls' }]]);
    await expect(update.normalize({ project: 'porch', project_step_done: 'paint' }, ctx)).rejects.toThrow(/could be/);
    await expect(update.normalize({ project: 'porch', project_status: 'finished' }, ctx)).rejects.toThrow(/Status must be/);
    await expect(update.normalize({ project: 'porch' }, ctx)).rejects.toThrow(/Say what to change/);
  });

  it('passes a "which project?" refusal through as the model\'s mistake', async () => {
    store.findByTitle.mockRejectedValue(new Error('"paint" could be "Paint office", "Paint halls" — say which.'));
    await expect(update.normalize({ project: 'paint', project_status: 'done' }, ctx)).rejects.toMatchObject({ code: 'invalid_action_params', message: expect.stringMatching(/say which/) });
  });

  it('writes each change through the same service the app uses', async () => {
    await update.execute(1, { project_uuid: 'p1', project_title: 'Porch steps', project_status: 'done', step_done_uuid: 's1', project_note: 'Looks great' });
    expect(store.update).toHaveBeenCalledWith(1, 'p1', { status: 'done' });
    expect(store.updateStep).toHaveBeenCalledWith(1, 'p1', 's1', { status: 'done' });
    expect(journal.add).toHaveBeenCalledWith(1, 'p1', { type: 'note', body: 'Looks great' }, { source: 'chat' });
  });
});
