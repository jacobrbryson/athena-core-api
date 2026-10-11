jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("uuid", () => ({ v4: () => "reply-uuid" }));
const pool = require("../helpers/db");
const messages = require("./message");
const sources = [{ title: "Example", url: "https://example.com/page" }];

beforeEach(() => jest.clearAllMocks());

test("source links survive saving and fetching history with either MySQL JSON representation", async () => {
  let stored;
  pool.query.mockImplementation(async (sql, params) => {
    if (sql.startsWith("INSERT")) {
      stored = params[6];
      return [{}];
    }
    expect(sql).toContain("r.sources");
    expect(sql).toContain("m.sources");
    expect(params).toEqual([7, 42, 42]);
    return [[{ uuid: "reply-uuid", text: "Reply", sources: stored }]];
  });
  await messages.addMessage(7, false, "Reply", "companion", null, sources);
  expect(stored).toBe(JSON.stringify(sources));
  expect((await messages.getMessages(7, 42))[0].sources).toEqual(sources);
  stored = JSON.parse(stored);
  expect((await messages.getMessages(7, 42))[0].sources).toEqual(sources);
});

test("older replies and replies without links keep their existing shape", async () => {
  pool.query.mockResolvedValue([[{ uuid: "old", sources: null }, { uuid: "empty", sources: [] }]]);
  const history = await messages.getMessages(7, 42);
  history.forEach((message) => expect(message.sources).toBeUndefined());
});

test("human messages and replies without sources store NULL", async () => {
  pool.query.mockResolvedValue([{}]);
  await messages.addMessage(7, true, "Question", "companion", 42, sources);
  expect(pool.query.mock.calls[0][1][6]).toBeNull();
  await messages.addMessage(7, false, "Reply");
  expect(pool.query.mock.calls[1][1][6]).toBeNull();
});

test('reply targets require both session presence and private-message ownership', async () => {
  pool.query.mockResolvedValue([[]]);
  expect(await messages.getReplyTarget(7, 'foreign-root', 42)).toBeNull();
  const [sql, params] = pool.query.mock.calls[0];
  expect(params).toEqual([7, 'foreign-root', 42, 42]);
  expect(sql).toContain('session_participant');
  expect(sql).toContain('m.private_profile_id IS NULL OR m.private_profile_id = ?');
});

test('thread context survives saving and history restoration', async () => {
  pool.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([[{ uuid: 'reply', reply_to_uuid: 'root', action_uuid: 'action' }]]);
  await messages.addMessage(7, false, 'Here is the result', 'companion', null, null,
    { replyTo: 'root', actionUuid: 'action', privateProfileId: 42 });
  expect(pool.query.mock.calls[0][1].slice(7)).toEqual(['root', 'action', 42]);
  const [reply] = await messages.getMessages(7, 42);
  expect(reply.reply_to_uuid).toBe('root');
  expect(reply.action_uuid).toBe('action');
});

test('older thread history keeps presence and ownership filters when paginating', async () => {
  pool.query.mockResolvedValue([[]]);
  await messages.getMessages(7, 42, { before: 'older', thread: 'root' });
  const [sql, params] = pool.query.mock.calls[0];
  expect(params).toEqual([7, 42, 42, 7, 'older', 'root', 'root']);
  expect(sql).toContain('m.uuid = ? OR m.reply_to_uuid = ?');
  expect(sql).toContain('session_participant');
});
