import { KRON, STATIONS } from '../src/config.js';
import { atHour, dateInMoscow, forecastDates, HOUR } from '../src/time.js';
export const moscow = value => Date.parse(`${value}+03:00`);
export function forecast(now, change = () => ({})) {
  return { spotId: KRON.id, source: 'windy', fetchedAt: now, modelUpdatedAt: now - HOUR,
    days: forecastDates(dateInMoscow(now)).map((date, day) => ({ date, slots: Array.from({ length: 24 }, (_, hour) => ({ hour, timestamp: atHour(date, hour), wind: 10, gust: null, direction: 230, ...change({ hour, day, date }) })) })) };
}
export function station(now, definition = STATIONS[0], options = {}) {
  const { wind = 9.5, direction = 230, ageMinutes = 2, gap = false } = options;
  const interval = definition.id === 'ULLI' ? 30 : 5;
  const history = Array.from({ length: Math.ceil(8 * 60 / interval) + 1 }, (_, i) => ({ timestamp: now - (ageMinutes + i * interval) * 60000, wind: Math.max(0, wind + Math.sin(i / 7) * 2), gust: null, min: null, direction }))
    .filter((r, i) => !gap || !(i > 9 && i < 17)).reverse();
  history.at(-1).wind = wind;
  return { ...definition, latest: history.at(-1), history };
}
export function windyPayload(now) {
  return { status: 'success', response: { timezone: 'Europe/Moscow', available_models: ['gfs27_long'], modelsUpdateTime: { gfs27: now / 1000 - 3600 },
    forecast: forecast(now).days.flatMap(d => d.slots.map(s => ({ timestamp: s.timestamp / 1000, UGRD: 3, VGRD: 4, GUST: null }))) } };
}
export const stationPayload = (now, wind = 5) => ({ status: 'success', response: { data: [{ timestamp: now / 1000 - 60, wind_avg: wind, wind_direction: 230, wind_min: null, wind_max: null }] } });
