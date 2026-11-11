// Pure decisions: no DOM, timers, storage or network.
import { getTimes } from '../node_modules/suncalc/index.js';
import { KRON, SCREENS } from './config.js';
import { knownWind, circularMean } from './model.js';
import { HOUR, addDays, atHour, dateInMoscow, forecastDates, hourInMoscow, validTime } from './time.js';

export const SCREEN_SEQUENCE = Object.freeze(SCREENS.map(s => Object.freeze([s.id, 10])));
export const CYCLE_MS = 50000;
export function cycleAt(elapsedMs) {
  const elapsed = Math.max(0, elapsedMs), position = elapsed % CYCLE_MS;
  const index = Math.floor(position / 10000);
  return { screen: SCREEN_SEQUENCE[index][0], cycle: Math.floor(elapsed / CYCLE_MS), index, remainingMs: 10000 - position % 10000 };
}
export const isWinter = date => [12, 1, 2, 3].includes(Number(date.slice(5, 7)));
export function ridingHours(spot, date, now) {
  if (!validTime(now)) return [];
  let start = atHour(date, 9), end = atHour(date, 22);
  if (!isWinter(date)) {
    if (!Number.isFinite(spot.lat) || !Number.isFinite(spot.lon)) return [];
    const sun = getTimes(new Date(atHour(date, 12)), spot.lat, spot.lon, 0, 180);
    if (sun.alwaysDown) return [];
    if (!sun.alwaysUp) {
      if (!sun.sunrise || !sun.sunset) return [];
      start = Math.max(start, +sun.sunrise); end = Math.min(end, +sun.sunset);
    }
  }
  return Array.from({ length: 13 }, (_, i) => i + 9).filter(hour => {
    const timestamp = atHour(date, hour);
    return timestamp >= now && timestamp >= start && timestamp + HOUR <= end;
  });
}
export function forecastStatus(forecast, now) {
  if (!validTime(now)) return { usable: false, code: 'clock' };
  if (!forecast?.days?.some(d => d.slots?.some(knownWind))) return { usable: false, code: 'missing' };
  if (![forecast.fetchedAt, forecast.modelUpdatedAt].every(Number.isFinite)) return { usable: false, code: 'stale' };
  if (forecast.fetchedAt > now + 300000 || forecast.modelUpdatedAt > now + 300000) return { usable: false, code: 'clock' };
  if (now - forecast.fetchedAt > 6 * HOUR || now - forecast.modelUpdatedAt > 18 * HOUR) return { usable: false, code: 'stale' };
  return { usable: true, code: forecast.warning ? 'offline' : 'fresh' };
}
export function slotFor(forecast, date, hour) {
  return forecast?.days?.find(d => d.date === date)?.slots?.find(s => s.timestamp === atHour(date, hour) && s.hour === hour) || null;
}
// Equal strength: earlier local session first, then nearest date. No gust/sector scores.
export function compareSessions(a, b) {
  const delta = b.wind - a.wind;
  return Math.abs(delta) > 1e-9 ? delta : a.start - b.start || a.date.localeCompare(b.date);
}
export function sessionsForDay(spot, forecast, date, now) {
  if (!forecastStatus(forecast, now).usable) return [];
  const hours = ridingHours(spot, date, now), sessions = [];
  for (const hour of hours) {
    if (!hours.includes(hour + 1)) continue;
    const pair = [slotFor(forecast, date, hour), slotFor(forecast, date, hour + 1)];
    if (!pair.every(knownWind)) continue;
    sessions.push({ date, start: hour, end: hour + 2, wind: (pair[0].wind + pair[1].wind) / 2, direction: circularMean(pair.map(s => s.direction)) });
  }
  return sessions.sort(compareSessions);
}
export function nearestHours(forecast, now) {
  if (!validTime(now)) return [];
  const start = Math.ceil(now / HOUR) * HOUR;
  return Array.from({ length: 4 }, (_, i) => {
    const timestamp = start + i * 2 * HOUR, date = dateInMoscow(timestamp), hour = hourInMoscow(timestamp);
    return { timestamp, date, hour, slot: slotFor(forecast, date, hour) };
  });
}
export function sessionHours(forecast, session, now) {
  if (!session) return [];
  const hours = ridingHours(KRON, session.date, now);
  // Shift the four-point row toward the period boundary. Short days remain padded.
  const first = Math.max(hours[0], Math.min(session.start - 2, hours.at(-1) - 6));
  return Array.from({ length: 4 }, (_, i) => {
    const hour = first + 2 * i, allowed = hours.includes(hour);
    return { date: session.date, hour: allowed ? hour : null, slot: allowed ? slotFor(forecast, session.date, hour) : null };
  });
}
export const STATUS_TEXT = { clock: 'НЕТ ВРЕМЕНИ', stale: 'УСТАРЕЛО', missing: 'НЕТ ДАННЫХ', offline: 'НЕТ СЕТИ', fresh: 'GFS27 М/С', demo: 'ДЕМО М/С' };
export function deriveDisplay({ forecasts = [], now, offline = false }) {
  const forecast = forecasts.find(f => f.spotId === KRON.id), freshness = forecastStatus(forecast, now);
  const status = !freshness.usable ? freshness.code : offline || forecast.warning ? 'offline' : forecast.source === 'demo' ? 'demo' : 'fresh';
  if (!validTime(now)) return { now, status, spot: KRON, detail: [], week: [], best: null, bestHours: [] };
  const dates = forecastDates(dateInMoscow(now), 7);
  const week = dates.map(date => ({ date, session: sessionsForDay(KRON, forecast, date, now)[0] || null, slots: Array.from({ length: 24 }, (_, hour) => slotFor(forecast, date, hour)) }));
  const best = forecastDates(addDays(dateInMoscow(now), 1), 7)
    .map(date => sessionsForDay(KRON, forecast, date, now)[0])
    .filter(Boolean).sort(compareSessions)[0] || null;
  return { now, status, spot: KRON, detail: nearestHours(forecast, now), week, best, bestHours: sessionHours(forecast, best, now) };
}
