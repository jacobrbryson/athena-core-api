jest.mock('../helpers/db', () => ({ query: jest.fn() }));
jest.mock('./news/fetch', () => ({ fetchPage: jest.fn(), robotsFor: jest.fn(), pageUrl: (v) => String(v) }));
jest.mock('./llm', () => ({ generateJson: jest.fn() }));

const places = require('./places');

/** Sunday 10:00 in Charlotte, the hour this feature was described in. */
const SUNDAY_10AM = new Date('2026-09-20T14:00:00Z');
const ZONE = 'America/New_York';
const trails = (over = {}) => ({
  state: 'open', statusText: 'Open', hours: { sun: [['07:00', '19:30']] }, ...over,
});

describe('openState', () => {
  it('is open inside posted hours, and says when it closes', () => {
    const now = places.openState(trails(), { at: SUNDAY_10AM, timeZone: ZONE });
    expect(now.openNow).toBe(true);
    expect(now.closesAt).toBe('7:30 PM');
    expect(now.closesInMinutes).toBe(570);
  });

  it('is closed before the gates open, and says when they do', () => {
    const now = places.openState(trails(), { at: new Date('2026-09-20T09:00:00Z'), timeZone: ZONE });
    expect(now.openNow).toBe(false);
    expect(now.opensAt).toBe('7:00 AM');
  });

  it('lets a posted closure outrank its own timetable', () => {
    const now = places.openState(trails({ state: 'closed', statusText: 'Closed — storm damage' }), { at: SUNDAY_10AM, timeZone: ZONE });
    expect(now.openNow).toBe(false);
    expect(now.why).toBe('Closed — storm damage');
  });

  it('is unknown, not open, when the page gave no hours at all', () => {
    const now = places.openState({ state: 'unknown', hours: null }, { at: SUNDAY_10AM, timeZone: ZONE });
    expect(now.openNow).toBeNull();
  });

  it('is closed — not unknown — on a day the page left out of its week', () => {
    const now = places.openState(trails({ hours: { mon: [['07:00', '19:30']] } }), { at: SUNDAY_10AM, timeZone: ZONE });
    expect(now.openNow).toBe(false);
    expect(now.why).toBe('Closed today');
  });

  it("reads the clock in the place's zone, not the server's", () => {
    // 02:00 UTC on Monday is still 22:00 Sunday in Charlotte — after closing,
    // but on Sunday's timetable. A UTC server would read Monday's.
    const now = places.openState(trails({ hours: { sun: [['07:00', '23:59']] } }), { at: new Date('2026-09-21T02:00:00Z'), timeZone: ZONE });
    expect(now.openNow).toBe(true);
  });
});

describe('cleanHours', () => {
  it('keeps well-formed windows and drops the rest', () => {
    expect(places.cleanHours({ sun: [['07:00', '19:30']], mon: [['bad', '19:30']], xyz: [['07:00', '08:00']] }))
      .toEqual({ sun: [['07:00', '19:30']] });
  });

  it('drops a window that ends before it starts rather than guessing', () => {
    expect(places.cleanHours({ sun: [['19:30', '07:00']] })).toBeNull();
  });

  it('returns null for nothing usable, so the card says unknown', () => {
    expect(places.cleanHours({})).toBeNull();
    expect(places.cleanHours(null)).toBeNull();
  });
});

describe('readableText', () => {
  it('strips scripts and markup down to the words', () => {
    const html = '<html><head><style>.a{}</style></head><body><script>var x=1</script><h1>Trails</h1><p>Open · 7:00AM - 7:30PM</p></body></html>';
    const text = places.readableText(html);
    expect(text).toContain('Trails');
    expect(text).toContain('7:00AM');
    expect(text).not.toContain('var x');
  });
});
