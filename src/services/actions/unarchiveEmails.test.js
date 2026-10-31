/**
 * unarchive_emails — Undo for the Mail page's archive. Weighted, like the rest
 * of the action layer, toward what it must refuse or skip.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));
jest.mock("../emailTriage", () => ({ getRowsByUuids: jest.fn(), markStatus: jest.fn() }));
jest.mock("../connectors/gmail", () => ({ archiveMessages: jest.fn(), unarchiveMessages: jest.fn() }));

const emailTriage = require("../emailTriage");
const gmail = require("../connectors/gmail");
const registry = require("./registry");

const undo = registry.get("unarchive_emails");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => jest.clearAllMocks());

test("needs a real approval every time and can never hold a standing approval", () => {
	expect(undo).toMatchObject({ provider: "gmail", consentType: "action_authority", reversible: true, standing: false });
	expect(undo.direct).toBeFalsy();
});

test("accepts 1-100 emails, drops duplicates, and refuses anything else", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([{ uuid: uuid(1), status: "archived" }, { uuid: uuid(2), status: "archived" }]);
	await expect(undo.normalize({ email_triage_uuids: [uuid(1), uuid(1), uuid(2)] }, { profileId: 42 })).resolves.toEqual({
		email_triage_uuids: [uuid(1), uuid(2)],
	});
	await expect(undo.normalize({}, { profileId: 42 })).rejects.toThrow(/at least one/);
	await expect(undo.normalize({ email_triage_uuids: Array.from({ length: 101 }, (_, i) => uuid(i)) }, { profileId: 42 })).rejects.toThrow(/Too many/);
	await expect(undo.normalize({ email_triage_uuids: [""] }, { profileId: 42 })).rejects.toThrow(/email_triage_uuid/);
});

test("vouches only for mail Athena archived, looked up under the caller's own profile", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([
		{ uuid: uuid(1), status: "archived" },
		{ uuid: uuid(2), status: "new" },
		{ uuid: uuid(3), status: "trashed" },
	]);
	const clean = await undo.normalize({ email_triage_uuids: [uuid(1), uuid(2), uuid(3)], extra: "inbox everything" }, { profileId: 42 });
	expect(emailTriage.getRowsByUuids).toHaveBeenCalledWith(42, [uuid(1), uuid(2), uuid(3)]);
	expect(clean).toEqual({ email_triage_uuids: [uuid(1)] });
});

test("refuses when none of the emails were archived", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([{ uuid: uuid(1), status: "new" }]);
	await expect(undo.normalize({ email_triage_uuids: [uuid(1)] }, { profileId: 42 })).rejects.toThrow(/archived by Athena/);
});

test("keeps the archive it undoes, as data only", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([{ uuid: uuid(1), status: "archived" }]);
	const clean = await undo.normalize({ email_triage_uuids: [uuid(1)], undoes: uuid(9) }, { profileId: 42 });
	expect(clean.undoes).toBe(uuid(9));
});

test("says plainly what will happen", () => {
	expect(undo.summarize({ email_triage_uuids: [uuid(1), uuid(2)] })).toBe("Move 2 emails back to your inbox");
});

test("restores only what is still archived, and marks just those open again", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([
		{ uuid: uuid(1), gmail_message_id: "g1", status: "archived" },
		{ uuid: uuid(2), gmail_message_id: "g2", status: "new" },
		{ uuid: uuid(3), gmail_message_id: "g3", status: "trashed" },
	]);
	const result = await undo.execute(42, { email_triage_uuids: [uuid(1), uuid(2), uuid(3)] });
	expect(gmail.unarchiveMessages).toHaveBeenCalledWith(42, ["g1"]);
	expect(emailTriage.markStatus).toHaveBeenCalledWith(42, [uuid(1)], "new");
	expect(result.detail).toEqual({ restored: 1 });
});

test("fails rather than pretending when nothing is archived any more, so a second Undo does nothing", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([{ uuid: uuid(1), gmail_message_id: "g1", status: "new" }]);
	await expect(undo.execute(42, { email_triage_uuids: [uuid(1)] })).rejects.toThrow(/archived any more/);
	expect(gmail.unarchiveMessages).not.toHaveBeenCalled();
	expect(emailTriage.markStatus).not.toHaveBeenCalled();
});
