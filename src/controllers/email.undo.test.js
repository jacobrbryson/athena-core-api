/**
 * proposeUndoArchive — Undo only proposes, and only for the caller's own
 * finished archive; the emails come from what was recorded, not the request.
 */
jest.mock("../helpers/actor", () => ({ requireAdultActor: jest.fn() }));
jest.mock("../services/emailTriage", () => ({}));
jest.mock("../services/actions", () => ({ get: jest.fn(), propose: jest.fn() }));
jest.mock("../services/connectors/gmail", () => ({}));
jest.mock("../services/emailDraft", () => ({}));

const { requireAdultActor } = require("../helpers/actor");
const actions = require("../services/actions");
const { proposeUndoArchive } = require("./email");

const res = () => {
	const r = { status: jest.fn(() => r), json: jest.fn(() => r) };
	return r;
};
const done = (over = {}) => ({ uuid: "a1", action_id: "archive_emails", status: "done", params: { email_triage_uuids: ["e1", "e2"] }, ...over });

beforeEach(() => {
	jest.clearAllMocks();
	requireAdultActor.mockResolvedValue({ profileId: 42 });
});

test("proposes unarchive with the emails recorded at the time, not the request's", async () => {
	actions.get.mockResolvedValue(done());
	actions.propose.mockResolvedValue({ uuid: "p1" });
	const r = res();
	await proposeUndoArchive({ body: { action_uuid: "a1", email_triage_uuids: ["someone-elses"] } }, r);
	expect(actions.get).toHaveBeenCalledWith(42, "a1");
	expect(actions.propose).toHaveBeenCalledWith(42, null, { id: "unarchive_emails", params: { email_triage_uuids: ["e1", "e2"], undoes: "a1" } });
	expect(r.json).toHaveBeenCalledWith({ success: true, action: { uuid: "p1" } });
});

test.each([
	["another action", done({ action_id: "unsubscribe_senders" })],
	["an archive that never ran", done({ status: "declined" })],
	["one that does not exist", null],
])("refuses %s", async (_label, original) => {
	actions.get.mockResolvedValue(original);
	const r = res();
	await proposeUndoArchive({ body: { action_uuid: "a1" } }, r);
	expect(r.status).toHaveBeenCalledWith(404);
	expect(actions.propose).not.toHaveBeenCalled();
});

test("refuses a missing action id without looking anything up", async () => {
	const r = res();
	await proposeUndoArchive({ body: {} }, r);
	expect(actions.get).not.toHaveBeenCalled();
	expect(r.status).toHaveBeenCalledWith(404);
});

test("does nothing for someone who is not a signed-in adult", async () => {
	requireAdultActor.mockResolvedValue(null);
	await proposeUndoArchive({ body: { action_uuid: "a1" } }, res());
	expect(actions.get).not.toHaveBeenCalled();
});
