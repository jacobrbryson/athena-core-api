/**
 * set_thermostat — mode, temperature and eco on the person's own Nest
 * thermostats, every change on a card they confirm. Weighted toward refusal:
 * normalize() is the only thing between a model's numbers and the furnace.
 */
jest.mock("../../helpers/db", () => ({ query: jest.fn() }));
jest.mock("../../security/access", () => ({ assertModelAccess: jest.fn() }));
jest.mock("../consent", () => ({ hasConsentForProfile: jest.fn() }));
jest.mock("../credentials", () => ({ list: jest.fn() }));
jest.mock("../family", () => ({ getFamilyForProfile: jest.fn() }));
jest.mock("../connectors/googleCalendar", () => ({ createEvent: jest.fn(), deleteEvent: jest.fn() }));
jest.mock("../lookRequests", () => ({ create: jest.fn() }));
jest.mock("../memory", () => ({ CATEGORIES: new Set(["other"]), upsertMemoryForProfile: jest.fn() }));
jest.mock("../connectors/nest", () => ({
	storedDevices: jest.fn(),
	executeCommands: jest.fn(),
	deviceTitle: (d) => d.displayName || `${d.room} thermostat`,
}));

const nest = require("../connectors/nest");
const registry = require("./registry");

const action = registry.get("set_thermostat");
const ctx = { profileId: 7 };
const den = {
	name: "enterprises/p/devices/den", displayName: "Den Thermostat", room: "Den", type: "thermostat",
	connectivity: "ONLINE", notReporting: false,
	readings: { mode: "COOL", coolC: 25, heatC: 20, eco: "OFF", scale: "FAHRENHEIT" },
};
const upstairs = { ...den, name: "enterprises/p/devices/up", displayName: null, room: "Upstairs", readings: { mode: "HEAT", heatC: 20.5, eco: "OFF", scale: "FAHRENHEIT" } };

beforeEach(() => {
	jest.clearAllMocks();
	nest.storedDevices.mockResolvedValue([den, upstairs]);
	nest.executeCommands.mockResolvedValue(1);
});

test("needs Nest linked, asks every time, and can be undone", () => {
	expect(action).toMatchObject({ provider: "nest", consentType: "action_authority", reversible: true, standing: false });
});

test("cool the Den to 74 °F: Fahrenheit converted, card in Fahrenheit, one SetCool", async () => {
	const p = await action.normalize({ thermostat: "den", cool_to: 74, unit: "F" }, ctx);
	expect(p).toEqual({ device_name: den.name, thermostat: "Den Thermostat", cool_c: 23.3, unit: "F" });
	expect(action.summarize(p)).toBe("Set the Den Thermostat: cool to 74°F");
	await action.execute(7, p);
	expect(nest.executeCommands).toHaveBeenCalledWith(7, den.name, [
		{ command: "sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool", params: { coolCelsius: 23.3 } },
	]);
});

test("switching mode and setting heat sends the mode first", async () => {
	const p = await action.normalize({ thermostat: "Den", mode: "heat", heat_to: 68, unit: "F" }, ctx);
	expect(action.summarize(p)).toBe("Set the Den Thermostat: switch to heat, then heat to 68°F");
	await action.execute(7, p);
	expect(nest.executeCommands.mock.calls[0][2].map((c) => c.command.split(".").slice(-2).join("."))).toEqual(["ThermostatMode.SetMode", "ThermostatTemperatureSetpoint.SetHeat"]);
});

test("heat-cool sets both ends, keeping the current one that wasn't given", async () => {
	const p = await action.normalize({ thermostat: "Den", mode: "HEATCOOL", heat_to: 66, unit: "F" }, ctx);
	expect(p).toMatchObject({ mode: "HEATCOOL", heat_c: 18.9, cool_c: 25 });
	expect(action.summarize(p)).toBe("Set the Den Thermostat: switch to heat-cool, then keep it between 66°F and 77°F");
});

test("eco: on alone; off before anything else", async () => {
	const on = await action.normalize({ thermostat: "upstairs", eco: "on" }, ctx);
	await action.execute(7, on);
	expect(nest.executeCommands.mock.calls[0][2]).toEqual([{ command: "sdm.devices.commands.ThermostatEco.SetMode", params: { mode: "MANUAL_ECO" } }]);
	nest.storedDevices.mockResolvedValue([{ ...upstairs, readings: { ...upstairs.readings, eco: "MANUAL_ECO" } }]);
	const off = await action.normalize({ thermostat: "Upstairs thermostat", eco: "off", heat_to: 21, unit: "C" }, ctx);
	expect(action.summarize(off)).toBe("Set the Upstairs thermostat: turn eco off, then heat to 21°C");
	await action.execute(7, off);
	expect(nest.executeCommands.mock.calls[1][2][0].command).toMatch(/ThermostatEco\.SetMode$/);
});

test("refuses: a temperature without a unit, out of bounds, or in the wrong mode", async () => {
	await expect(action.normalize({ thermostat: "Den", cool_to: 22 }, ctx)).rejects.toThrow(/unit/);
	await expect(action.normalize({ thermostat: "Upstairs", heat_to: 85, unit: "F" }, ctx)).rejects.toThrow(/50 °F and 80 °F/);
	await expect(action.normalize({ thermostat: "Upstairs", heat_to: 45, unit: "F" }, ctx)).rejects.toThrow(/50 °F and 80 °F/);
	await expect(action.normalize({ thermostat: "Den", cool_to: 58, unit: "F" }, ctx)).rejects.toThrow(/62 °F and 88 °F/);
	await expect(action.normalize({ thermostat: "Den", cool_to: 74, unit: "K" }, ctx)).rejects.toThrow(/F or C/);
	await expect(action.normalize({ thermostat: "Den", heat_to: 68, unit: "F" }, ctx)).rejects.toThrow(/COOL mode/);
	await expect(action.normalize({ thermostat: "Den", mode: "OFF", cool_to: 74, unit: "F" }, ctx)).rejects.toThrow(/heat, cool or heat-cool/);
	await expect(action.normalize({ thermostat: "Den", mode: "HEATCOOL", heat_to: 75, cool_to: 76, unit: "F" }, ctx)).rejects.toThrow(/3 °F/);
	await expect(action.normalize({ thermostat: "Den", mode: "BLAST" }, ctx)).rejects.toThrow(/Mode must be/);
	await expect(action.normalize({ thermostat: "Den", eco: "on", cool_to: 74, unit: "F" }, ctx)).rejects.toThrow(/Eco on cannot/);
	expect(nest.executeCommands).not.toHaveBeenCalled();
});

test("refuses: a thermostat that isn't theirs, is ambiguous, or can't be reached", async () => {
	await expect(action.normalize({ thermostat: "Garage", cool_to: 74, unit: "F" }, ctx)).rejects.toThrow(/no thermostat called/);
	await expect(action.normalize({ cool_to: 74, unit: "F" }, ctx)).rejects.toThrow(/which thermostat/);
	nest.storedDevices.mockResolvedValue([den, { ...den, name: "enterprises/p/devices/den2" }]);
	await expect(action.normalize({ thermostat: "Den", cool_to: 74, unit: "F" }, ctx)).rejects.toThrow(/More than one/);
	nest.storedDevices.mockResolvedValue([{ ...den, connectivity: "OFFLINE", notReporting: true }]);
	await expect(action.normalize({ thermostat: "Den", cool_to: 74, unit: "F" }, ctx)).rejects.toThrow(/not reporting/);
	// A device name the model writes is never used: only the stored row's.
	nest.storedDevices.mockResolvedValue([den]);
	const p = await action.normalize({ thermostat: "Den", cool_to: 74, unit: "F", device_name: "enterprises/evil/devices/x" }, ctx);
	expect(p.device_name).toBe(den.name);
});

test("refuses: nothing to change, eco blocking a setpoint, or what it already is", async () => {
	await expect(action.normalize({ thermostat: "Den" }, ctx)).rejects.toThrow(/Nothing to change/);
	await expect(action.normalize({ thermostat: "Den", mode: "COOL" }, ctx)).rejects.toThrow(/already set/);
	nest.storedDevices.mockResolvedValue([{ ...den, readings: { ...den.readings, eco: "MANUAL_ECO" } }]);
	await expect(action.normalize({ thermostat: "Den", cool_to: 74, unit: "F" }, ctx)).rejects.toThrow(/Eco is on/);
});

test("the reply schema lets the model write these params, with closed sets", () => {
	const props = registry.paramsSchema().properties;
	expect(props.heat_to).toEqual({ type: "number" });
	expect(props.mode.enum).toEqual(["HEAT", "COOL", "HEATCOOL", "OFF"]);
	expect(props.unit.enum).toEqual(["F", "C"]);
	expect(props.thermostat).toEqual({ type: "string" });
});
