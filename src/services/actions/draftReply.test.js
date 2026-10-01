/**
 * draft_reply — saves a reply to Gmail's Drafts. Never sends.
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
jest.mock("../connectors/gmail", () => ({
	getMessage: jest.fn(), createDraft: jest.fn(),
	headerValue: (m, name) => (m.payload.headers.find((h) => h.name.toLowerCase() === name) || {}).value || "",
}));

const emailTriage = require("../emailTriage");
const gmail = require("../connectors/gmail");
const registry = require("./registry");

const draft = registry.get("draft_reply");
const UUID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => jest.clearAllMocks());

test("reversible, approval every time, and the card shows the words being saved", () => {
	expect(draft).toMatchObject({ provider: "gmail", reversible: true, standing: false });
	const p = draft.normalize({ email_triage_uuid: UUID, body: "  Sending it tonight.  ", to_name: "Shawn", send: true });
	expect(p).toEqual({ email_triage_uuid: UUID, body: "Sending it tonight.", to_name: "Shawn" });
	expect(draft.summarize(p)).toBe('Save a draft reply to Shawn in Gmail — not sent: "Sending it tonight."');
	expect(() => draft.normalize({ email_triage_uuid: UUID, body: "   " })).toThrow(/some text/);
});

test("saves a threaded draft to the Reply-To address and nothing else", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([{ uuid: UUID, gmail_message_id: "m1", thread_id: "t1", subject: "Roster" }]);
	gmail.getMessage.mockResolvedValue({ threadId: "t1", payload: { headers: [
		{ name: "From", value: "Shawn <shawn@example.com>" }, { name: "Reply-To", value: "coach@example.com" },
		{ name: "Subject", value: "Roster" }, { name: "Message-ID", value: "<abc@mail>" },
	] } });
	gmail.createDraft.mockResolvedValue({ id: "d1" });
	const r = await draft.execute(42, { email_triage_uuid: UUID, body: "Sending it tonight." });
	const { raw, threadId } = gmail.createDraft.mock.calls[0][1];
	expect(threadId).toBe("t1");
	expect(Buffer.from(raw, "base64url").toString("utf8")).toMatch(/^To: coach@example.com\r\nSubject: Re: Roster\r\nIn-Reply-To: <abc@mail>/);
	expect(emailTriage.markStatus).toHaveBeenCalledWith(42, [UUID], "actioned");
	expect(r).toEqual({ ref: "d1", detail: { drafted: true } });
	expect(Object.keys(gmail)).not.toContain("sendMessage");
});
