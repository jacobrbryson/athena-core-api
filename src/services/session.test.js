/**
 * Session authorization tests.
 *
 * Sessions used to be resumable by (uuid + IP), so a child moving between wifi
 * and cell data silently lost their conversation. Identity is the key now:
 * a profile-bound session is authorized by a PROVEN profile, and only a truly
 * anonymous session still falls back to the IP check.
 */
jest.mock("../helpers/db", () => ({ query: jest.fn() }));
jest.mock("./sessionParticipant", () => ({
  isParticipant: jest.fn(),
  mayJoin: jest.fn(),
  joinSession: jest.fn(),
}));
// `uuid` ships ESM only, which jest can't transform here.
jest.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }));

const pool = require("../helpers/db");
const participants = require("./sessionParticipant");
const sessions = require("./session");

const row = (over = {}) => ({
  id: 7,
  uuid: "sess-abc",
  ip_address: "1.2.3.4",
  profile_id: null,
  family_id: null,
  mode: "companion",
  age: 5,
  is_busy: 0,
  wisdom_points: 0,
  ...over,
});

beforeEach(() => {
  pool.query.mockReset();
  // Default: nobody has been admitted to anything. Each test that cares about
  // membership says so explicitly, so a test never passes because a mock
  // quietly let somebody in.
  participants.isParticipant.mockReset().mockResolvedValue(false);
  participants.mayJoin.mockReset().mockResolvedValue(false);
  participants.joinSession.mockReset().mockResolvedValue({ joined: true });
});

describe("getAuthorizedSession — profile-bound sessions", () => {
  test("the owning profile resumes from a DIFFERENT ip", async () => {
    pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
    const s = await sessions.getAuthorizedSession("sess-abc", {
      ip: "9.9.9.9", // moved from wifi to cell data
      callerProfileId: 42,
    });
    expect(s).toMatchObject({ id: 7, profile_id: 42 });
  });

  test("the lookup no longer filters on ip", async () => {
    pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
    await sessions.getAuthorizedSession("sess-abc", {
      ip: "9.9.9.9",
      callerProfileId: 42,
    });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain("s.ip_address = ?");
    expect(params).toEqual(["sess-abc"]);
  });

  test("a different profile is refused even on the ORIGINAL ip", async () => {
    pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
    const s = await sessions.getAuthorizedSession("sess-abc", {
      ip: "1.2.3.4",
      callerProfileId: 43,
    });
    expect(s).toBeNull();
  });

  test("an unauthenticated caller cannot resume a bound session", async () => {
    // This is the case the old IP check was standing in for: knowing the
    // session uuid must not be enough.
    pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
    expect(
      await sessions.getAuthorizedSession("sess-abc", {
        ip: "1.2.3.4",
        callerProfileId: null,
      }),
    ).toBeNull();
  });

  test("string/number profile ids compare correctly", async () => {
    pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
    const s = await sessions.getAuthorizedSession("sess-abc", {
      ip: null,
      callerProfileId: "42",
    });
    expect(s).not.toBeNull();
  });
});

describe("getAuthorizedSession — anonymous sessions", () => {
  test("a matching ip still resumes", async () => {
    pool.query.mockResolvedValueOnce([[row()]]);
    const s = await sessions.getAuthorizedSession("sess-abc", {
      ip: "1.2.3.4",
    });
    expect(s).toMatchObject({ id: 7 });
  });

  test("a different ip is refused — there is no identity to fall back on", async () => {
    pool.query.mockResolvedValueOnce([[row()]]);
    expect(
      await sessions.getAuthorizedSession("sess-abc", { ip: "9.9.9.9" }),
    ).toBeNull();
  });

  test("no ip at all is refused", async () => {
    pool.query.mockResolvedValueOnce([[row()]]);
    expect(
      await sessions.getAuthorizedSession("sess-abc", { ip: null }),
    ).toBeNull();
  });

  test("a proven profile does NOT unlock somebody else's anonymous session", async () => {
    pool.query.mockResolvedValueOnce([[row()]]);
    expect(
      await sessions.getAuthorizedSession("sess-abc", {
        ip: "9.9.9.9",
        callerProfileId: 42,
      }),
    ).toBeNull();
  });
});

describe("getAuthorizedSession — basics", () => {
  test("an unknown session is null", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    expect(
      await sessions.getAuthorizedSession("nope", { ip: "1.2.3.4" }),
    ).toBeNull();
  });

  test("a missing uuid never hits the database", async () => {
    expect(
      await sessions.getAuthorizedSession("", { ip: "1.2.3.4" }),
    ).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("getAuthorizedSession — a second guardian in the same conversation", () => {
  test("an admitted participant resumes a session that is not theirs", async () => {
    pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
    participants.isParticipant.mockResolvedValue(true);
    const s = await sessions.getAuthorizedSession("sess-abc", {
      ip: "9.9.9.9",
      callerProfileId: 99,
    });
    expect(s).toMatchObject({ id: 7, profile_id: 42 });
    expect(participants.isParticipant).toHaveBeenCalledWith(7, 99);
  });

  test("someone who has NOT been admitted is still refused", async () => {
    pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
    const s = await sessions.getAuthorizedSession("sess-abc", {
      ip: "1.2.3.4",
      callerProfileId: 99,
    });
    expect(s).toBeNull();
  });

  test("reading never grants membership — this path only recognizes it", async () => {
    pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
    await sessions.getAuthorizedSession("sess-abc", { callerProfileId: 99 });
    expect(participants.joinSession).not.toHaveBeenCalled();
    expect(participants.mayJoin).not.toHaveBeenCalled();
  });

  test("a membership lookup that throws refuses, it does not admit", async () => {
    pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
    participants.isParticipant.mockRejectedValue(new Error("db down"));
    expect(
      await sessions.getAuthorizedSession("sess-abc", { callerProfileId: 99 }),
    ).toBeNull();
  });

  test("an anonymous session is not joinable by membership", async () => {
    // profile_id IS NULL takes the IP branch, which no membership can satisfy.
    pool.query.mockResolvedValueOnce([[row()]]);
    participants.isParticipant.mockResolvedValue(true);
    expect(
      await sessions.getAuthorizedSession("sess-abc", {
        ip: "9.9.9.9",
        callerProfileId: 99,
      }),
    ).toBeNull();
  });
});

describe("admitToSession", () => {
  test("refuses when mayJoin says no, and writes nothing", async () => {
    pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
    expect(await sessions.admitToSession("sess-abc", 99)).toBeNull();
    expect(participants.joinSession).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1); // the lookup only
  });

  test("refuses an unauthenticated caller without touching the database", async () => {
    expect(await sessions.admitToSession("sess-abc", null)).toBeNull();
    expect(await sessions.admitToSession("", 99)).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("refuses an unknown session", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    expect(await sessions.admitToSession("nope", 99)).toBeNull();
    expect(participants.mayJoin).not.toHaveBeenCalled();
  });

  test("admits from the START of the conversation, not from now", async () => {
    // The decision the feature rests on: they were in the room while it
    // happened, so a backdated span is what keeps the transcript intact.
    pool.query.mockResolvedValueOnce([
      [row({ profile_id: 42, created_at: "2026-09-18 09:00:00" })],
    ]);
    participants.mayJoin.mockResolvedValue(true);
    pool.query.mockResolvedValueOnce([{ insertId: 1 }]); // audit row
    const s = await sessions.admitToSession("sess-abc", 99);
    expect(s).toMatchObject({ id: 7 });
    expect(participants.joinSession).toHaveBeenCalledWith(7, 99, {
      via: "joined",
      joinedAt: "2026-09-18 09:00:00",
    });
  });

  test("records the join in the access audit", async () => {
    pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
    participants.mayJoin.mockResolvedValue(true);
    pool.query.mockResolvedValueOnce([{ insertId: 1 }]);
    await sessions.admitToSession("sess-abc", 99);
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toContain("athena_access_audit");
    expect(params).toEqual(["sess-abc", "session_joined", "99"]);
  });

  test("a failed audit write does not undo a join that already happened", async () => {
    pool.query.mockResolvedValueOnce([[row({ profile_id: 42 })]]);
    participants.mayJoin.mockResolvedValue(true);
    pool.query.mockRejectedValueOnce(new Error("audit table gone"));
    expect(await sessions.admitToSession("sess-abc", 99)).toMatchObject({
      id: 7,
    });
  });
});
