const { FLOOR, REACH, MIN_TESTS, provenAt, score, personRollup } = require("./abilities");

jest.mock("../../helpers/db", () => ({ query: jest.fn() }));

const tests = (n, { reach = 1, passed = 1, withPeople = 1 } = {}) => Array.from({ length: n }, () => ({ passed, reach, with_people: withPeople }));
const links = [{ cap_key: "a", weight: 3 }, { cap_key: "b", weight: 1 }];

describe("provenAt", () => {
	test("needs enough tests, not one lucky pass", () => {
		expect(provenAt(tests(MIN_TESTS - 1), 1)).toBe(false);
		expect(provenAt(tests(MIN_TESTS), 1)).toBe(true);
	});

	test("failures keep it unproven", () => {
		expect(provenAt([...tests(3, { passed: 0 }), ...tests(3)], 1)).toBe(false);
	});

	test("a test proves its own reach and below, never above", () => {
		expect(provenAt(tests(3, { reach: 2 }), 1)).toBe(true);
		expect(provenAt(tests(3, { reach: 2 }), 2)).toBe(true);
		expect(provenAt(tests(3, { reach: 2 }), 3)).toBe(false);
	});
});

describe("score", () => {
	test("everything starts at the floor", () => {
		expect(FLOOR).toBe(1);
		expect(score("perception", links, {})).toMatchObject({ percent: 1, rung: 0, reach: null });
	});

	test("an ability with no capabilities stays at the floor", () => {
		expect(score("adaptation", [], {})).toMatchObject({ percent: 1, rung: 0, next: null });
	});

	test("hours and tries don't count, only passing", () => {
		expect(score("perception", links, { a: tests(500, { passed: 0 }), b: tests(500, { passed: 0 }) }).percent).toBe(1);
	});

	test("proving part of an ability moves it by weight", () => {
		const s = score("perception", links, { a: tests(3) });
		expect(s.percent).toBe(1.8);
		expect(s.next).toMatchObject({ name: "Household", proven: 1, total: 2 });
	});

	test("proving everything at home stops at the household ceiling", () => {
		const s = score("perception", links, { a: tests(50), b: tests(50) });
		expect(s).toMatchObject({ percent: REACH[0].ceiling, rung: 1, reach: "Household" });
		expect(s.next.name).toBe("Neighborhood");
	});

	test("only tests at a bigger reach climb the ladder", () => {
		const s = score("perception", links, { a: tests(3, { reach: 6 }), b: tests(3, { reach: 6 }) });
		expect(s).toMatchObject({ percent: 100, rung: 6, reach: "World", next: null });
	});

	test("solo tests can't earn the top rungs of Communication or Coordination", () => {
		const solo = { a: tests(3, { reach: 6, withPeople: 0 }), b: tests(3, { reach: 6, withPeople: 0 }) };
		expect(score("communication", links, solo)).toMatchObject({ rung: 4, next: { name: "Nation", peopleOnly: true } });
		expect(score("coordination", links, solo).rung).toBe(4);
		expect(score("perception", links, solo).rung).toBe(6);
		const people = { a: tests(3, { reach: 6 }), b: tests(3, { reach: 6 }) };
		expect(score("communication", links, people).rung).toBe(6);
	});
});

describe("personRollup", () => {
	const rows = [{ id: 1, ability_key: "communication", name: "Communication" }, { id: 2, ability_key: "action", name: "Action" }];
	const refs = [
		{ cap_key: "reads_morse", ability_id: 1, kind: "skill" },
		{ cap_key: "sends_morse", ability_id: 1, kind: "skill" },
		{ cap_key: "push_notification", ability_id: 1, kind: "system" },
	];

	test("counts a person's skills, ignores Athena's tools and empty abilities", () => {
		expect(personRollup([{ cap_key: "reads_morse", level: "reliable" }], refs, rows)).toEqual([{ key: "communication", name: "Communication", reliable: 1, learning: 0, total: 2 }]);
	});
});
