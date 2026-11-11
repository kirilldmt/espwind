import { DEFAULT_SETTINGS, DEFAULT_SPOTS } from './config.js';
import { timeInMoscow, validTime } from './time.js';
const KEY = 'wind64.settings.v2';
export function initialState(storage) {
  let saved;
  try { saved = JSON.parse(storage?.getItem(KEY)); } catch { /* A blocked or old store falls back to defaults. */ }
  const settings = { ...DEFAULT_SETTINGS };
  const s = saved?.settings;
  if (s) {
    for (const key of ['brightness', 'nightBrightness']) if (Number.isFinite(s[key]) && s[key] >= 0 && s[key] <= 100) settings[key] = s[key];
    if (['day', 'night', 'schedule'].includes(s.mode)) settings.mode = s.mode;
    if (['pixel', 'led'].includes(s.view)) settings.view = s.view;
    for (const key of ['nightStart', 'nightEnd']) if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s[key])) settings[key] = s[key];
  }
  // Only display preferences migrate from v2; old spots/stations never affect the cycle.
  return { screen: 'detail', auto: true, source: 'windy', scenario: 'mixed', stations: [], stationError: null, now: Date.now(), simulationTime: null, clockKnown: true, offline: false, spots: structuredClone(DEFAULT_SPOTS), settings };
}
export function saveState(state, storage) {
  try { storage?.setItem(KEY, JSON.stringify({ settings: state.settings })); return !!storage; } catch { return false; }
}
export function brightnessAt(settings, date = new Date()) {
  const now = +date;
  const [hour, minute] = validTime(now) ? timeInMoscow(now).split(':').map(Number) : [0, 0];
  const minutes = hour * 60 + minute;
  const toMinutes = str => { const [h, m] = str.split(':').map(Number); return h * 60 + m; };
  const start = toMinutes(settings.nightStart), end = toMinutes(settings.nightEnd);
  const scheduledNight = start !== end && (start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end);
  const night = !validTime(now) || settings.mode === 'night' || (settings.mode === 'schedule' && scheduledNight);
  return { night, value: night ? Math.min(settings.brightness, settings.nightBrightness) : settings.brightness };
}
