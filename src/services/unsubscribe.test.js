jest.mock("node:dns", () => ({ promises: { lookup: jest.fn() } }));
const dns = require("node:dns").promises;
const { oneClickUrl, isPrivateAddress, send } = require("./unsubscribe");

beforeEach(() => jest.clearAllMocks());

test("only an RFC 8058 one-click https link is ever used", () => {
	const post = "List-Unsubscribe=One-Click";
	expect(oneClickUrl("<mailto:u@x.com>, <https://x.com/u?t=1>", post)).toBe("https://x.com/u?t=1");
	expect(oneClickUrl("<https://x.com/u>", "")).toBeNull(); // no one-click promise
	expect(oneClickUrl("<http://x.com/u>", post)).toBeNull(); // not https
	expect(oneClickUrl("<mailto:u@x.com>", post)).toBeNull(); // would mean sending email
	expect(oneClickUrl("<https://user:pw@x.com/u>", post)).toBeNull();
	expect(oneClickUrl("https://x.com/u", post)).toBeNull(); // not in angle brackets
});

test.each([
	["127.0.0.1", true], ["10.1.2.3", true], ["172.20.0.1", true], ["192.168.1.1", true], ["169.254.169.254", true],
	["100.64.0.1", true], ["0.0.0.0", true], ["::1", true], ["fd00::1", true], ["fe80::1", true], ["::ffff:127.0.0.1", true],
	["93.184.216.34", false], ["2606:4700::1111", false], ["not-an-ip", true],
])("private address check: %s → %s", (address, expected) => {
	expect(isPrivateAddress(address)).toBe(expected);
});

test("sends the fixed one-click body without following redirects or sending credentials", async () => {
	dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
	const fetchImpl = jest.fn(async () => ({ status: 200 }));
	expect(await send("https://list.example.com/u?t=abc", { fetchImpl })).toEqual({ ok: true, status: 200 });
	const [url, init] = fetchImpl.mock.calls[0];
	expect(url).toBe("https://list.example.com/u?t=abc");
	expect(init).toMatchObject({ method: "POST", body: "List-Unsubscribe=One-Click", redirect: "manual", credentials: "omit" });
});

test("refuses a host that resolves anywhere private, before any request is made", async () => {
	dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]);
	const fetchImpl = jest.fn();
	await expect(send("https://sneaky.example.com/u", { fetchImpl })).rejects.toThrow(/private address/);
	await expect(send("https://169.254.169.254/latest/meta-data", { fetchImpl })).rejects.toThrow(/private address/);
	await expect(send("http://list.example.com/u", { fetchImpl })).rejects.toThrow(/https/);
	expect(fetchImpl).not.toHaveBeenCalled();
});

test("a refusal or a network failure is reported, not thrown", async () => {
	dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
	expect(await send("https://x.example.com/u", { fetchImpl: async () => ({ status: 404 }) })).toEqual({ ok: false, status: 404 });
	const down = await send("https://x.example.com/u", { fetchImpl: async () => { throw new Error("ECONNRESET"); } });
	expect(down).toMatchObject({ ok: false, error: "ECONNRESET" });
});
