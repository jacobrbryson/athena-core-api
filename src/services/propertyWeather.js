// Reuse the same address lookup and NWS forecast as conversation weather.
const travel = require('./travel');
const weather = require('./weather');
const locations = new Map();
async function read(profileId, address) {
  const key = `${profileId}:${address}`;
  let hit = locations.get(key);
  if (!hit || Date.now() >= hit.expires) {
    hit = { expires: Date.now() + 30 * 60_000, point: travel.locate(profileId, address) };
    locations.set(key, hit);
    if (locations.size > 100) locations.delete(locations.keys().next().value);
  }
  const point = await hit.point;
  if (!point) { hit.expires = Math.min(hit.expires, Date.now() + 60_000); return null; }
  // Select the period containing now rather than the earliest cached period.
  const sky = await weather.forecast(point.latitude, point.longitude, { hours: 24, from: new Date().toISOString() });
  if (!sky?.now) return null;
  const temperatures = sky.hours.map(h => h.temperatureF).filter(Number.isFinite);
  return { temperatureF: sky.now.temperatureF, description: sky.now.shortForecast,
    highF: temperatures.length ? Math.max(...temperatures) : null,
    lowF: temperatures.length ? Math.min(...temperatures) : null,
    checkedAt: sky.checkedAt, periodStart: sky.now.start };
}
module.exports = { read };
