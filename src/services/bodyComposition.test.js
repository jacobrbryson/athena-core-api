const { estimate, enrich } = require('./bodyComposition');

// 191 cm, 82 kg, 40-year-old man, 480 Ω: index = 191²/480 = 76.0
const man = { weightKg: 82, heightCm: 191, impedance: 480, age: 40, sex: 'male' };

test('published equations, by hand', () => {
  const e = estimate(man);
  const index = 191 ** 2 / 480;
  // Sun 2003, men: FFM = -10.68 + 0.65·H²/R + 0.26·W + 0.02·R
  const ffm = -10.68 + 0.65 * index + 0.26 * 82 + 0.02 * 480;
  expect(e.fat_free_mass_kg).toBeCloseTo(ffm, 6);
  expect(e.body_fat_percent).toBeCloseTo((1 - ffm / 82) * 100, 6);
  // Sun 2003, men: TBW = 1.20 + 0.45·H²/R + 0.18·W
  expect(e.body_water_percent).toBeCloseTo(((1.2 + 0.45 * index + 0.18 * 82) / 82) * 100, 6);
  // Janssen 2000: SMM = 0.401·H²/R + 3.825·male − 0.071·age + 5.102
  expect(e.skeletal_muscle_kg).toBeCloseTo(0.401 * index + 3.825 - 0.071 * 40 + 5.102, 6);
  // Katch-McArdle
  expect(e.bmr_kcal).toBeCloseTo(370 + 21.6 * ffm, 6);
  expect(e.estimated).toEqual(expect.arrayContaining(['body_fat_percent', 'body_water_percent', 'skeletal_muscle_kg', 'fat_free_mass_kg', 'bmr_kcal']));
});

test("the scale's own body fat wins, and fat-free mass follows it", () => {
  const e = estimate({ ...man, bodyFatPercent: 15 });
  expect(e.body_fat_percent).toBeNull(); // not re-estimated
  expect(e.fat_free_mass_kg).toBeCloseTo(82 * 0.85, 6);
  expect(e.estimated).not.toContain('body_fat_percent');
});

test('women use the female equations; unknown sex or a silly impedance estimates nothing from impedance', () => {
  const index = 165 ** 2 / 560;
  const e = estimate({ weightKg: 62, heightCm: 165, impedance: 560, age: 35, sex: 'female' });
  expect(e.fat_free_mass_kg).toBeCloseTo(-9.53 + 0.69 * index + 0.17 * 62 + 0.02 * 560, 6);
  expect(e.skeletal_muscle_kg).toBeCloseTo(0.401 * index - 0.071 * 35 + 5.102, 6);
  expect(estimate({ ...man, sex: null }).skeletal_muscle_kg).toBeNull();
  expect(estimate({ ...man, impedance: 20 }).body_water_percent).toBeNull();
});

const weighIn = (daysAgo, over = {}) => ({
  at: new Date(Date.now() - daysAgo * 86400000).toISOString(), weight_kg: 82, body_fat_percent: 15,
  height_cm: 191, impedance_ohm: 480, age: 40, sex: 'male', ...over,
});

test('a DEXA reference shifts body fat and moves fat-free mass and BMR with it', () => {
  const days = [weighIn(1), weighIn(30, { body_fat_percent: 16 })];
  const dexaDay = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
  const { weighIns, calibration } = enrich(days, [{ uuid: 'r1', measured_on: dexaDay, source: 'DEXA', body_fat_percent: 19 }]);
  expect(calibration.corrections.body_fat_percent).toMatchObject({ kind: 'shift', amount: 3, source: 'DEXA' });
  expect(weighIns[0].body_fat_percent).toBe(18); // 15 + 3
  expect(weighIns[0].fat_free_mass_kg).toBeCloseTo(82 * 0.82, 1);
  expect(weighIns[0].bmr_kcal).toBe(Math.round(370 + 21.6 * 82 * 0.82));
  expect(weighIns[0].calibrated).toContain('body_fat_percent');
});

test('a muscle reference scales the estimate; a measured height re-does BMI', () => {
  const days = [weighIn(0)];
  const raw = enrich(days).weighIns[0];
  const today = new Date().toISOString().slice(0, 10);
  const { weighIns } = enrich(days, [{ uuid: 'r', measured_on: today, skeletal_muscle_kg: raw.skeletal_muscle_kg * 1.1, height_cm: 190 }]);
  expect(weighIns[0].skeletal_muscle_kg).toBeCloseTo(raw.skeletal_muscle_kg * 1.1, 1);
  expect(weighIns[0].bmi).toBeCloseTo(82 / 1.9 ** 2, 1);
});

test('a reference with no weigh-in within a week is reported, not applied', () => {
  const { weighIns, calibration } = enrich([weighIn(0)], [{ uuid: 'r', measured_on: '2020-01-01', body_fat_percent: 25 }]);
  expect(calibration.unmatched).toContain('body_fat_percent');
  expect(weighIns[0].body_fat_percent).toBe(15);
});
