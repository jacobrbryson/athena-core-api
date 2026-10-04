jest.mock("./sessionParticipant", () => ({ presentParticipants: jest.fn() }));
const sessionParticipants = require("./sessionParticipant");
const { reporter, activityFor } = require("./activity");

const flush = () => new Promise((r) => setImmediate(r));

function fakeClients(uuid) {
	const sent = [];
	const ws = { readyState: 1, OPEN: 1, send: (s) => sent.push(JSON.parse(s)) };
	return { clients: new Map([[uuid, new Set([ws])]]), sent };
}

const session = { id: 7, uuid: "u-1", profile_id: 3 };

describe("activity reporter", () => {
	beforeEach(() => sessionParticipants.presentParticipants.mockResolvedValue([{ profileId: 3 }]));

	it("announces a real read and ends it when the read ends", async () => {
		const { clients, sent } = fakeClients("u-1");
		const { onRead } = reporter({ session, clients });
		const end = onRead("google_calendar");
		await flush();
		expect(sent).toEqual([{ rpc: "activity", activity: "calendar", state: "start" }]);
		end();
		await flush();
		expect(sent[1]).toEqual({ rpc: "activity", activity: "calendar", state: "end" });
	});

	it("shares one start and one end between overlapping reads of the same thing", async () => {
		const { clients, sent } = fakeClients("u-1");
		const { onRead } = reporter({ session, clients });
		const a = onRead("gmail");
		const b = onRead("gmail");
		await flush();
		a();
		await flush();
		expect(sent).toHaveLength(1);
		b();
		await flush();
		expect(sent.map((m) => m.state)).toEqual(["start", "end"]);
	});

	it("says nothing for sources it has no activity for", async () => {
		const { clients, sent } = fakeClients("u-1");
		const { onRead } = reporter({ session, clients });
		onRead("whoop")();
		await flush();
		expect(sent).toEqual([]);
		expect(activityFor("whoop")).toBeNull();
	});

	it("stays silent on a shared conversation", async () => {
		sessionParticipants.presentParticipants.mockResolvedValue([{ profileId: 3 }, { profileId: 4 }]);
		const { clients, sent } = fakeClients("u-1");
		const { onRead } = reporter({ session, clients });
		onRead("gmail")();
		await flush();
		expect(sent).toEqual([]);
	});

	it("stays silent for Guardian sessions and unbound sessions", async () => {
		const { clients, sent } = fakeClients("u-1");
		reporter({ session, clients, guardian: true }).onRead("gmail")();
		reporter({ session: { ...session, profile_id: null }, clients }).onRead("gmail")();
		await flush();
		expect(sent).toEqual([]);
	});

	it("stays silent when it cannot tell who is present", async () => {
		sessionParticipants.presentParticipants.mockRejectedValue(new Error("db"));
		const { clients, sent } = fakeClients("u-1");
		reporter({ session, clients }).onRead("gmail")();
		await flush();
		expect(sent).toEqual([]);
	});
});
