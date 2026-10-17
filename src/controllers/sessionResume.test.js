/**
 * GET /session — picking a conversation up on another device.
 *
 * The clients remember a session uuid per browser, so the server is where a
 * second device finds the conversation the first one was having.
 */
jest.mock("../services/session", () => ({
  getAuthorizedSession: jest.fn(),
  admitToSession: jest.fn(),
  resolveProfileBinding: jest.fn(),
  resolveProfileIdBinding: jest.fn(),
  bindSessionProfile: jest.fn(),
  updateSession: jest.fn(),
  latestForProfile: jest.fn(),
  resumeForProfile: jest.fn(),
  addSession: jest.fn(),
}));
jest.mock("../services/conversationMode", () => ({
  resolveMode: jest.fn(async (m) => m || "teach"),
  listModes: jest.fn(async () => [{ key: "companion" }]),
}));
jest.mock("../services/familyPermissions", () => ({
  gateMode: jest.fn(async (m) => m),
  allowedModesForProfile: jest.fn(async () => ["companion"]),
}));
jest.mock("../helpers/utils", () => ({ extractIp: () => "9.9.9.9" }));
jest.mock("../helpers/callerIdentity", () => ({ resolveCallerProfileId: jest.fn() }));
jest.mock("../services/sessionParticipant", () => ({
  presentParticipants: jest.fn(async () => []),
}));

const sessions = require("../services/session");
const { resolveCallerProfileId } = require("../helpers/callerIdentity");
const getOrCreateSession = require("./session");

function call(query) {
  const res = { json: jest.fn(), status: jest.fn(() => res) };
  return getOrCreateSession({ query, body: {} }, res).then(() => res.json.mock.calls[0][0]);
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveCallerProfileId.mockResolvedValue(42);
  sessions.resolveProfileIdBinding.mockResolvedValue({ profileId: 42, familyId: 3 });
  sessions.resolveProfileBinding.mockResolvedValue({});
  sessions.resumeForProfile.mockImplementation(async (_p, _m, s) => s);
});

test("a new device resumes the person's latest conversation", async () => {
  sessions.latestForProfile.mockResolvedValue({ id: 9, uuid: "laptop", profile_id: 42, mode: "companion" });
  const body = await call({ mode: "companion" });
  expect(body.session.uuid).toBe("laptop");
  expect(sessions.addSession).not.toHaveBeenCalled();
});

test("a Guardians session is bound to the proven caller, not left anonymous", async () => {
  sessions.getAuthorizedSession.mockResolvedValue({
    id: 7, uuid: "phone", profile_id: null, mode: "companion", created_at: "2026-10-01",
  });
  const body = await call({ sessionId: "phone", mode: "companion" });
  expect(sessions.bindSessionProfile).toHaveBeenCalledWith(7, 42, 3, { joinedAt: "2026-10-01" });
  expect(sessions.resumeForProfile).toHaveBeenCalledWith(42, "companion", expect.objectContaining({ id: 7 }));
  expect(body.session.profile_id).toBe(42);
});

test("a fresh session is bound to the proven caller", async () => {
  sessions.latestForProfile.mockResolvedValue(null);
  sessions.addSession.mockResolvedValue("new-uuid");
  await call({ mode: "companion", profile_uuid: "someone-else" });
  expect(sessions.resolveProfileBinding).not.toHaveBeenCalled();
  expect(sessions.addSession).toHaveBeenCalledWith("9.9.9.9", { mode: "companion", profileId: 42, familyId: 3 });
});

test("an anonymous caller still starts its own session", async () => {
  resolveCallerProfileId.mockResolvedValue(null);
  sessions.addSession.mockResolvedValue("anon");
  const body = await call({ mode: "companion" });
  expect(sessions.latestForProfile).not.toHaveBeenCalled();
  expect(body.session.uuid).toBe("anon");
});
