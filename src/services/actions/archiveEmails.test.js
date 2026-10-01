/**
 * archive_emails — the Mail card's bundle action. Weighted, like the rest of
 * the action layer, toward what it must refuse or skip.
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
jest.mock("../connectors/gmail", () => ({ archiveMessages: jest.fn() }));

const emailTriage = require("../emailTriage");
const gmail = require("../connectors/gmail");
const registry = require("./registry");

const archive = registry.get("archive_emails");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => jest.clearAllMocks());

test("is reversible, needs a real approval every time, and writes through Gmail", () => {
	expect(archive).toMatchObject({ provider: "gmail", consentType: "action_authority", reversible: true, standing: false });
});

test("accepts 1-100 emails, drops duplicates, and refuses anything else", () => {
	expect(archive.normalize({ email_triage_uuids: [uuid(1), uuid(1), uuid(2)] })).toEqual({ email_triage_uuids: [uuid(1), uuid(2)] });
	expect(() => archive.normalize({})).toThrow(/at least one/);
	expect(() => archive.normalize({ email_triage_uuids: Array.from({ length: 101 }, (_, i) => uuid(i)) })).toThrow(/Too many/);
	expect(() => archive.normalize({ email_triage_uuids: [""] })).toThrow(/email_triage_uuid/);
	expect(Object.keys(archive.normalize({ email_triage_uuids: [uuid(1)], extra: "trash them" }))).toEqual(["email_triage_uuids"]);
});

test("says plainly that nothing is deleted", () => {
	expect(archive.summarize({ email_triage_uuids: [uuid(1), uuid(2)] })).toMatch(/Archive 2 emails.*All Mail/);
});

test("archives only this person's still-open emails, and marks just those", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([
		{ uuid: uuid(1), gmail_message_id: "g1", status: "new" },
		{ uuid: uuid(2), gmail_message_id: "g2", status: "gone" },
		{ uuid: uuid(3), gmail_message_id: "g3", status: "actioned" },
	]);
	const result = await archive.execute(42, { email_triage_uuids: [uuid(1), uuid(2), uuid(3), uuid(4)] });
	expect(emailTriage.getRowsByUuids).toHaveBeenCalledWith(42, [uuid(1), uuid(2), uuid(3), uuid(4)]);
	expect(gmail.archiveMessages).toHaveBeenCalledWith(42, ["g1"]);
	expect(emailTriage.markStatus).toHaveBeenCalledWith(42, [uuid(1)], "archived");
	expect(result.detail).toEqual({ archived: 1 });
});

test("fails rather than pretending when nothing is left to archive", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([{ uuid: uuid(1), gmail_message_id: "g1", status: "archived" }]);
	await expect(archive.execute(42, { email_triage_uuids: [uuid(1)] })).rejects.toThrow(/still in the inbox/);
	expect(gmail.archiveMessages).not.toHaveBeenCalled();
});
