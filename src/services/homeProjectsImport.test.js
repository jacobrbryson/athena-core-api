jest.mock('../helpers/db', () => ({ query: jest.fn() }));

const { preview, effortToMinutes, statusFrom, parseDelimited } = require('./homeProjectsImport');

describe('preview', () => {
  it('reads a spreadsheet the way someone would have written one', () => {
    const csv = [
      'Task,Room,Status,Priority,Est. Hours,Indoor,Notes',
      'Rehang garage shelves,Garage,Not started,High,2,Yes,Brackets are in the truck',
      'Stain the deck,Backyard,In progress,Normal,6,No,Needs two dry days',
      'Replace porch light,Porch,Done,Low,0.5,No,',
    ].join('\n');
    const result = preview(csv);
    expect(result.projects).toHaveLength(3);
    expect(result.projects[0]).toMatchObject({
      title: 'Rehang garage shelves', area: 'Garage', status: 'todo',
      priority: 'high', effortMinutes: 120, indoor: true,
    });
    expect(result.projects[1]).toMatchObject({ status: 'in_progress', effortMinutes: 360, indoor: false });
    expect(result.projects[2].status).toBe('done');
  });

  it('takes a clipboard paste, which is tab separated', () => {
    const result = preview('Task\tRoom\nFix the gate\tSide yard');
    expect(result.projects[0]).toMatchObject({ title: 'Fix the gate', area: 'Side yard' });
  });

  it('does not eat the first row when there is no header', () => {
    const result = preview('Rehang garage shelves\nStain the deck');
    expect(result.projects.map((p) => p.title)).toEqual(['Rehang garage shelves', 'Stain the deck']);
  });

  it('keeps quoted commas and embedded newlines intact', () => {
    const result = preview('Task,Notes\n"Shelves, garage","Two coats,\nthen sand"');
    expect(result.projects[0].title).toBe('Shelves, garage');
    expect(result.projects[0].detail).toContain('then sand');
  });

  it('names the columns it could not place instead of silently dropping them', () => {
    const result = preview('Task,Who is doing it\nFix the gate,Ross');
    expect(result.unmapped).toEqual(['Who is doing it']);
  });

  it('reports rows it skipped, with the line number', () => {
    const result = preview('Task,Room\n,Garage\nFix the gate,Side yard');
    expect(result.projects).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ line: 1, reason: 'no title in that row' });
  });

  it('refuses an empty paste with something a person can act on', () => {
    expect(() => preview('   ')).toThrow(/no rows/i);
  });
});

describe('effortToMinutes', () => {
  it('reads a bare number as hours, because a spreadsheet means hours', () => {
    expect(effortToMinutes('1.5')).toBe(90);
  });
  it('honours a stated unit', () => {
    expect(effortToMinutes('45 min')).toBe(45);
    expect(effortToMinutes('2 days')).toBe(960);
  });
  it('is null rather than zero when there is nothing to read', () => {
    expect(effortToMinutes('')).toBeNull();
    expect(effortToMinutes('tbd')).toBeNull();
  });
});

describe('statusFrom', () => {
  it('maps the words people actually type', () => {
    expect(statusFrom('✓')).toBe('done');
    expect(statusFrom('WIP')).toBe('in_progress');
    expect(statusFrom('waiting on parts')).toBe('blocked');
    expect(statusFrom('')).toBe('todo');
  });
});

describe('parseDelimited', () => {
  it('drops blank rows, which every exported sheet has', () => {
    expect(parseDelimited('a,b\n\n,\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });
});
