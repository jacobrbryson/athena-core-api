jest.mock('./llm', () => ({ generateJson: jest.fn(), search: jest.fn() }));
jest.mock('./healthPlan', () => ({
  ENTRY: { calories: [0, 6000], protein_g: [0, 500], carbs_g: [0, 1000], fat_g: [0, 400], water_oz: [0, 200] },
  addEntry: jest.fn(async (profileId, body) => ({ uuid: 'new', ...body })),
}));
const llm = require('./llm');
const healthPlan = require('./healthPlan');
const foodScan = require('./foodScan');

const IMAGE = { imageBase64: 'x'.repeat(200), mimeType: 'image/jpeg' };
const off = (product) => jest.fn().mockResolvedValue({ ok: true, json: async () => (product ? { status: 1, product } : { status: 0 }) });
const realFetch = global.fetch;

beforeEach(() => jest.clearAllMocks());
afterAll(() => { global.fetch = realFetch; });

test('barcodes are trusted only when the check digit holds', () => {
  expect(foodScan.validBarcode('5000159484695')).toBe('5000159484695'); // EAN-13
  expect(foodScan.validBarcode('036000291452')).toBe('036000291452'); // UPC-A
  expect(foodScan.validBarcode('036000291453')).toBeNull();
  expect(foodScan.validBarcode('12345')).toBeNull();
});

test('a barcode the phone read logs one serving from the food database, no model call', async () => {
  global.fetch = off({ product_name: 'Twix', brands: 'Mars,Inc', serving_size: '1 bar (50 g)', serving_quantity: 50, nutriments: { 'energy-kcal_100g': 495, proteins_100g: 4.5, carbohydrates_100g: 64, fat_100g: 24 } });
  const r = await foodScan.scan(42, { barcode: '5000159484695', eaten_on: '2026-10-15' });
  expect(llm.generateJson).not.toHaveBeenCalled();
  expect(global.fetch.mock.calls[0][0]).toContain('/5000159484695.json');
  expect(r.how).toBe('barcode');
  expect(healthPlan.addEntry).toHaveBeenCalledWith(42, expect.objectContaining({ label: 'Mars Twix', serving: '1 bar (50 g)', calories: 248, protein_g: 2.3, carbs_g: 32, fat_g: 12, barcode: '5000159484695', source: 'barcode', eaten_on: '2026-10-15' }));
});

test('a bad barcode is refused before any lookup', async () => {
  global.fetch = jest.fn();
  await expect(foodScan.scan(42, { barcode: '036000291453' })).rejects.toThrow("doesn't look right");
  expect(global.fetch).not.toHaveBeenCalled();
});

test('a plate is estimated by the vision model and clamped into what an entry accepts', async () => {
  llm.generateJson.mockResolvedValue({ data: { kind: 'food', label: 'Chicken rice bowl', serving: '1 bowl', calories: 9999, protein_g: 48.26, carbs_g: 80, fat_g: -3, note: 'Assumed white rice.' } });
  const r = await foodScan.scan(42, IMAGE);
  expect(llm.generateJson.mock.calls[0][0].task).toBe('vision');
  expect(r.how).toBe('photo');
  expect(r.note).toContain('Assumed white rice');
  expect(healthPlan.addEntry).toHaveBeenCalledWith(42, expect.objectContaining({ label: 'Chicken rice bowl', calories: 6000, protein_g: 48.3, fat_g: null, source: 'photo' }));
});

test('a barcode the model read in the photo is looked up; unknown ones fall back to an estimate', async () => {
  global.fetch = off(null);
  llm.generateJson
    .mockResolvedValueOnce({ data: { kind: 'barcode', barcode: '036000291452' } })
    .mockResolvedValueOnce({ data: { kind: 'food', label: 'Granola bar', calories: 190, protein_g: 4, carbs_g: 29, fat_g: 7 } });
  const r = await foodScan.scan(42, IMAGE);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(r.how).toBe('photo');
  expect(healthPlan.addEntry).toHaveBeenCalledWith(42, expect.objectContaining({ label: 'Granola bar', barcode: '036000291452' }));
});

test('nothing recognisable logs nothing', async () => {
  llm.generateJson.mockResolvedValue({ data: { kind: 'none' } });
  await expect(foodScan.scan(42, IMAGE)).rejects.toMatchObject({ status: 422 });
  expect(healthPlan.addEntry).not.toHaveBeenCalled();
  await expect(foodScan.scan(42, {})).rejects.toMatchObject({ status: 400 });
});

test('a described food is looked up on the web, then its published numbers are logged', async () => {
  llm.search.mockResolvedValue({ text: "McDonald's Big Mac: 590 Cal, 25 g protein, 46 g carbs, 34 g fat per sandwich (219 g)." });
  llm.generateJson.mockResolvedValue({ data: { kind: 'food', label: "McDonald's Big Mac", serving: '1 sandwich (219 g)', calories: 590, protein_g: 25, carbs_g: 46, fat_g: 34, note: "McDonald's published nutrition." } });
  const r = await foodScan.describe(42, { text: '  Big Mac from   McDonalds ', eaten_on: '2026-10-15' });
  expect(llm.search.mock.calls[0][0]).toContain('Big Mac from McDonalds');
  expect(llm.generateJson.mock.calls[0][0].contents[0].parts[0].text).toContain('590 Cal');
  expect(r.how).toBe('described');
  expect(r.note).toContain("McDonald's published nutrition");
  expect(healthPlan.addEntry).toHaveBeenCalledWith(42, expect.objectContaining({ label: "McDonald's Big Mac", calories: 590, fat_g: 34, source: 'described', eaten_on: '2026-10-15' }));
});

test('a failed search still logs an estimate; nonsense and empty text log nothing', async () => {
  llm.search.mockRejectedValue(new Error('quota'));
  llm.generateJson.mockResolvedValueOnce({ data: { kind: 'food', label: 'Banana', calories: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.4 } });
  const r = await foodScan.describe(42, { text: 'a banana' });
  expect(llm.generateJson.mock.calls[0][0].contents[0].parts[0].text).toContain('No web search result');
  expect(r.note).toContain('Estimated');
  llm.generateJson.mockResolvedValueOnce({ data: { kind: 'none' } });
  await expect(foodScan.describe(42, { text: 'my car keys' })).rejects.toMatchObject({ status: 422 });
  await expect(foodScan.describe(42, { text: ' ' })).rejects.toMatchObject({ status: 400 });
  expect(healthPlan.addEntry).toHaveBeenCalledTimes(1);
});
