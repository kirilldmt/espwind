import { normalizeWindy, normalizeStation, dateInMoscow, emptyForecast } from './src/weather.js';
import { DEFAULT_SPOTS, STATIONS } from './src/config.js';
const FORECAST_TTL = 30 * 60000, STATION_TTL = 60000;
async function getJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Wind64PersonalPrototype/4.0' } });
  if (!response.ok) throw new Error(`Источник ответил HTTP ${response.status}`);
  return response.json();
}
// Injected clock/transport allow cache and failure tests without hitting the upstream.
export function createWeatherService({ fetchJSON = getJSON, clock = Date.now } = {}) {
  const forecastCache = new Map(), stationCache = new Map(), pending = new Map();
  async function oneForecast(spot) {
    const now = clock(), date = dateInMoscow(now), key = `forecast/${spot.id}`;
    const cached = forecastCache.get(key);
    if (cached?.date === date && now - cached.attemptedAt < FORECAST_TTL) return { ...cached.response, cache: true };
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      const start = Date.parse(`${date}T00:00:00+03:00`);
      const query = new URLSearchParams({ method: 'forecastConstructor', from_ts: String(start / 1000), to_ts: String(start / 1000 + 8 * 86400), lat: String(spot.lat), lon: String(spot.lon), models: 'gfs27_long', period: '1h', userID: 'webForecastWidgetAPI' });
      let response;
      try { response = normalizeWindy(await fetchJSON(`https://api.windyapp.co/apiV9.php?${query}`), spot, { now, baseDate: date }); }
      catch (error) {
        // Keep every last successful value, including at midnight. The UI ages it independently.
        response = cached?.success ? { ...cached.success, warning: String(error.message).slice(0, 180), cache: true } : emptyForecast(spot, String(error.message).slice(0, 180), date);
      }
      forecastCache.set(key, { date, attemptedAt: now, response, success: response.error || response.warning ? cached?.success : response });
      return response;
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  async function oneStation(definition) {
    const now = clock(), key = `station/${definition.id}`, cached = stationCache.get(key);
    if (cached && now - cached.attemptedAt < STATION_TTL) return cached.response;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      let response;
      try {
        response = normalizeStation(await fetchJSON(`https://api.windyapp.co/v10/meteostations/getData/${definition.id}?predict=0&canWindNull=1&info=1`), definition, now);
        if (cached?.success) {
          const history = new Map(cached.success.history.map(r => [r.timestamp, r]));
          response.history.forEach(r => history.set(r.timestamp, r));
          response.history = [...history.values()].filter(r => r.timestamp >= now - 30 * 3600000).sort((a, b) => a.timestamp - b.timestamp);
          response.latest = response.history.at(-1) || response.latest;
        }
      } catch (error) { response = { ...(cached?.success || { ...definition, source: 'windy', history: [], latest: null }), error: String(error.message).slice(0, 180) }; }
      stationCache.set(key, { attemptedAt: now, response, success: response.error ? cached?.success : response });
      return response;
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  return {
    getForecasts: () => Promise.all(DEFAULT_SPOTS.map(oneForecast)),
    getStations: async () => {
      const stations = await Promise.all(STATIONS.map(oneStation));
      return { source: 'windy', stations, error: stations.some(s => s.error) ? 'Сбой обновления станции' : null };
    },
  };
}
export const { getForecasts, getStations } = createWeatherService();
