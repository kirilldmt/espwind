// Network-independent parsers. Unknown inputs stay null; timestamps are UTC seconds.
const finite = v => typeof v === 'number' && Number.isFinite(v);
import { STATIONS } from './config.js';
import { MOSCOW, dateInMoscow, forecastDates, atHour, validTime } from './time.js';
export { MOSCOW, dateInMoscow, forecastDates } from './time.js';
export function directionFromUV(u, v) { return (180 + Math.atan2(u, v) * 180 / Math.PI + 360) % 360; }
export function normalizeWindy(payload, spot, { now = Date.now(), baseDate = dateInMoscow(now) } = {}) {
  const r = payload?.response;
  if (payload?.status !== 'success' || !r || !Array.isArray(r.forecast)) throw new Error('Windy.app: неверный формат ответа');
  if (r.timezone !== MOSCOW) throw new Error('Windy.app: неожиданный часовой пояс');
  if (!r.available_models?.some(m => ['gfs27', 'gfs27_long'].includes(m))) throw new Error('Windy.app: модель GFS27 недоступна');
  const modelTime = r.modelsUpdateTime?.gfs27;
  if (!finite(modelTime) || now / 1000 - modelTime > 18 * 3600 || modelTime > now / 1000 + 300) throw new Error('Windy.app: прогноз модели устарел');
  const hours = new Map();
  for (const row of r.forecast) {
    if (!finite(row.timestamp)) continue;
    const time = row.timestamp * 1000;
    const date = dateInMoscow(time), hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: MOSCOW, hour: '2-digit', hourCycle: 'h23' }).format(time));
    const key = `${date}/${hour}`;
    // This provider promises hourly data; duplicate or off-hour rows are ambiguous.
    if (row.timestamp % 3600 || hours.has(key)) throw new Error('Windy.app: повторное или непочасовое значение');
    const u = row.UGRD, v = row.VGRD, gust = row.GUST;
    const wind = finite(u) && finite(v) && Math.hypot(u, v) <= 100 ? Math.hypot(u, v) : null;
    hours.set(key, { hour, timestamp: time, wind, gust: finite(gust) && gust >= 0 && gust <= 100 ? gust : null, direction: wind !== null ? directionFromUV(u, v) : null, u, v });
  }
  const days = forecastDates(baseDate).map(date => ({ date, slots: Array.from({ length: 24 }, (_, hour) => {
    const row = hours.get(`${date}/${hour}`);
    return row || { hour, timestamp: atHour(date, hour), wind: null, gust: null, direction: null };
  }) }));
  if (!days.some(d => d.slots.some(s => s.wind !== null))) throw new Error('Windy.app: нет почасового прогноза');
  return { spotId: spot.id, source: 'windy', model: 'GFS27', timezone: MOSCOW, fetchedAt: now, modelUpdatedAt: modelTime * 1000, days };
}
export function emptyForecast(spot, error, baseDate = dateInMoscow()) {
  return { spotId: spot.id, source: 'windy', timezone: MOSCOW, error, days: forecastDates(baseDate).map(date => ({ date, slots: Array.from({ length: 24 }, (_, hour) => ({ hour, timestamp: atHour(date, hour), wind: null, gust: null, direction: null })) })) };
}
export function normalizeStation(payload, definition, now = Date.now()) {
  if (payload?.status !== 'success' || !Array.isArray(payload.response?.data)) throw new Error('Windy.app: неверный ответ станции');
  const byTime = new Map();
  for (const row of payload.response.data) {
    if (!finite(row.timestamp) || !validTime(row.timestamp * 1000) || row.timestamp * 1000 > now + 300000) continue;
    const wind = finite(row.wind_avg) && row.wind_avg >= 0 && row.wind_avg <= 100 ? row.wind_avg : null;
    byTime.set(row.timestamp, {
      timestamp: row.timestamp * 1000, wind,
      min: finite(row.wind_min) && row.wind_min >= 0 && wind !== null && row.wind_min <= wind ? row.wind_min : null,
      gust: finite(row.wind_max) && wind !== null && row.wind_max >= wind && row.wind_max <= 100 ? row.wind_max : null,
      direction: finite(row.wind_direction) && row.wind_direction >= 0 && row.wind_direction <= 360 ? row.wind_direction % 360 : null,
    });
  }
  const history = [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (!history.length) throw new Error('Windy.app: нет измерений станции');
  return { ...definition, source: 'windy', fetchedAt: now, history, latest: history.at(-1) };
}
export function stationStatus(station, now = Date.now()) {
  if (!validTime(now)) return { kind: 'unknown', label: 'Нет времени', ageMinutes: null, fresh: false };
  if (!station?.latest) return { kind: 'unknown', label: 'Нет данных', ageMinutes: null, fresh: false };
  const age = (now - station.latest.timestamp) / 60000;
  if (age < -5) return { kind: 'unknown', label: 'Ошибка времени', ageMinutes: null, fresh: false };
  const ageMinutes = Math.max(0, Math.floor(age));
  const definition = STATIONS.find(s => s.id === station.id) || STATIONS[0];
  if (age >= definition.staleMinutes) return { kind: 'unknown', label: 'Устарело', ageMinutes, fresh: false };
  if (!finite(station.latest.wind)) return { kind: 'unknown', label: 'Нет данных', ageMinutes, fresh: false };
  const delayed = age >= definition.warningMinutes;
  return { kind: delayed ? 'caution' : 'good', label: delayed ? 'Задержка' : 'Свежие данные', ageMinutes, fresh: true };
}
