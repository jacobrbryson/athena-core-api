/**
 * unsubscribe_senders — the one Mail action that cannot be undone. The link it
 * calls must come from Athena's stored copy of the email, never from params.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));
jest.mock("../emailTriage", () => ({
	getRowsByUuids: jest.fn(), markStatus: jest.fn(), openFromSender: jest.fn(),
	safeJson: (t) => { try { return JSON.parse(t); } catch { return null; } },
}));
jest.mock("../connectors/gmail", () => ({ archiveMessages: jest.fn() }));
jest.mock("../unsubscribe", () => ({ send: jest.fn() }));

const emailTriage = require("../emailTriage");
const gmail = require("../connectors/gmail");
const unsubscribe = require("../unsubscribe");
const registry = require("./registry");

const action = registry.get("unsubscribe_senders");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => jest.clearAllMocks());

test("cannot be undone, so it says so and never runs on a standing approval", () => {
	expect(action).toMatchObject({ reversible: false, standing: false, consentType: "action_authority" });
	const p = action.normalize({ items: [{ email_triage_uuid: uuid(1), sender: "Target" }, { email_triage_uuid: uuid(2), sender: "Old Navy" }] });
	expect(action.summarize(p)).toMatch(/Unsubscribe from Target, Old Navy .*can't be undone/);
});

test("params can name rows and display names, but never carry a link", () => {
	const p = action.normalize({ items: [{ email_triage_uuid: uuid(1), sender: "Target", url: "https://evil.example/u" }], url: "https://evil.example" });
	expect(p).toEqual({ items: [{ email_triage_uuid: uuid(1), sender: "Target" }] });
	expect(() => action.normalize({ items: Array.from({ length: 11 }, (_, i) => ({ email_triage_uuid: uuid(i) })) })).toThrow(/Too many/);
});

test("calls the stored link, archives that sender's waiting mail, and skips rows with no link", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([
		{ uuid: uuid(1), group_key: "target.com", extracted: JSON.stringify({ sorted: 2, unsub: "https://target.example/u?t=1" }) },
		{ uuid: uuid(2), group_key: "nolink.com", extracted: JSON.stringify({ sorted: 2 }) },
	]);
	emailTriage.openFromSender.mockResolvedValue([{ uuid: uuid(1), gmail_message_id: "g1" }, { uuid: uuid(3), gmail_message_id: "g3" }]);
	unsubscribe.send.mockResolvedValue({ ok: true, status: 200 });
	const r = await action.execute(42, { items: [{ email_triage_uuid: uuid(1) }, { email_triage_uuid: uuid(2) }] });
	expect(unsubscribe.send).toHaveBeenCalledTimes(1);
	expect(unsubscribe.send).toHaveBeenCalledWith("https://target.example/u?t=1");
	expect(gmail.archiveMessages).toHaveBeenCalledWith(42, ["g1", "g3"]);
	expect(r.detail).toEqual({ unsubscribed: 1, failed: 1, archived: 2 });
});

test("a sender that refuses is reported and its mail is left alone; all refusing is a failure", async () => {
	emailTriage.getRowsByUuids.mockResolvedValue([{ uuid: uuid(1), group_key: "x.com", extracted: JSON.stringify({ unsub: "https://x.example/u" }) }]);
	unsubscribe.send.mockResolvedValue({ ok: false, status: 404 });
	await expect(action.execute(42, { items: [{ email_triage_uuid: uuid(1) }] })).rejects.toThrow(/accepted/);
	expect(gmail.archiveMessages).not.toHaveBeenCalled();
});
