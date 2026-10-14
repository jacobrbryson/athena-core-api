jest.mock('./travel', () => ({ locate: jest.fn() }));
jest.mock('./weather', () => ({ forecast: jest.fn() }));
const travel = require('./travel');
const weather = require('./weather');
const { read } = require('./propertyWeather');
beforeEach(() => jest.clearAllMocks());
test('geocodes the saved address and uses the current forecast period', async () => {
  travel.locate.mockResolvedValue({ latitude: 40, longitude: -81 });
  weather.forecast.mockResolvedValue({ now: { temperatureF: 62, shortForecast: 'Sunny', start: 'now' }, hours: [{ temperatureF: 62 }, { temperatureF: 68 }, { temperatureF: 49 }, { temperatureF: null }], checkedAt: 'checked' });
  const result = await read(42, 'Property one');
  expect(travel.locate).toHaveBeenCalledWith(42, 'Property one');
  expect(weather.forecast).toHaveBeenCalledWith(40, -81, { hours: 24, from: expect.any(String) });
  expect(result).toEqual({ temperatureF: 62, description: 'Sunny', highF: 68, lowF: 49, checkedAt: 'checked', periodStart: 'now' });
  await read(42, 'Property one');
  expect(travel.locate).toHaveBeenCalledTimes(1);
});
test('a changed address is geocoded again and missing coverage returns null', async () => {
  travel.locate.mockResolvedValue({ latitude: 39, longitude: -80 });
  weather.forecast.mockResolvedValue(null);
  expect(await read(42, 'Property two')).toBeNull();
  expect(travel.locate).toHaveBeenCalledWith(42, 'Property two');
});
test('an address that cannot be located does not request weather', async () => {
  travel.locate.mockResolvedValue(null);
  expect(await read(42, 'Unknown property')).toBeNull();
  expect(weather.forecast).not.toHaveBeenCalled();
});
