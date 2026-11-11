import { DISPLAY, DIRECTIONS, SCREENS, STATIONS, WIND_SCALE } from './config.js';
import { DemoForecastProvider, WindyForecastProvider, WindyStationProvider } from './provider.js';
import { emptyForecast, stationStatus } from './weather.js';
import { initialState, saveState, brightnessAt } from './state.js';
import { deriveDisplay, cycleAt, STATUS_TEXT } from './controller.js';
import { dateInMoscow, timeInMoscow, validTime } from './time.js';
import { renderScreen } from './render.js';
import { historyGraph } from './history-graph.js';
import { ParticleFlow } from './particles.js';
import { transitionFrame } from './framebuffer.js';
import { paintPixels, paintLED, downloadPNG } from './viewer.js';

const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const pad = n => String(n).padStart(2, '0');
const fmt = n => Number.isFinite(n) ? n.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) : '—';
const directionText = n => Number.isFinite(n) ? DIRECTIONS[Math.round(n / 45) % 8] : 'направление неизвестно';
const dateText = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
let storage;
try { storage = window.localStorage; } catch { /* Private environments may disable storage. */ }
const state = initialState(storage), demoProvider = new DemoForecastProvider(), windyProvider = new WindyForecastProvider(), stationProvider = new WindyStationProvider();
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const flows = Object.fromEntries(STATIONS.map((s, i) => [s.screen, new ParticleFlow(i + 1)]));
let forecasts = state.spots.map(s => emptyForecast(s, 'Загрузка…'));
let loadingWeather = false, loadingStations = false, loadVersion = 0, lastForecastDate = null;
let cycleStart = performance.now(), lastTick = -1, transition = null, lastFrameTime = 0, lastBrightness = -1, toastTimer;
let framesRendered = 0, canvasPaints = 0, totalRenderMs = 0, maxRenderMs = 0, lastUIKey = '', lastPaintedView = null, lastPaintedData = null;
function recompute() {
  state.now = state.clockKnown ? (state.simulationTime ?? Date.now()) : null;
  state.presentation = deriveDisplay({ ...state, forecasts });
  state.graphs = Object.fromEntries(STATIONS.map(s => [s.id, historyGraph(state.stations.find(station => station.id === s.id), state.now)]));
}
recompute();
let currentRaw = renderScreen(state, forecasts), currentFrame = currentRaw;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 3500); }
function persist() { if (!saveState(state, storage)) toast('Настройки работают в этой вкладке; браузер запретил сохранение.'); }
function commit(change, animation = 'slide') {
  const before = currentRaw.clone(); change();
  transition = animation && !reduceMotion.matches ? { from: before, start: performance.now(), type: animation } : null;
  recompute(); syncUI();
}
async function reloadData() {
  if (state.simulateOffline || !navigator.onLine) return;
  const version = ++loadVersion, source = state.source;
  const now = validTime(state.now) ? state.now : Date.now();
  lastForecastDate = dateInMoscow(now); loadingWeather = true; syncWeatherStatus();
  let next;
  try { next = await (source === 'windy' ? windyProvider.load() : demoProvider.load(state.spots, { scenario: state.scenario, now })); }
  catch (error) { next = state.spots.map(spot => emptyForecast(spot, error.message)); }
  if (version !== loadVersion || state.simulateOffline) return;
  next = next.map(f => {
    const previous = forecasts.find(old => old.spotId === f.spotId && old.source === source);
    return f.error && previous?.days.some(d => d.slots.some(s => s.wind !== null)) ? { ...previous, warning: f.error } : f;
  });
  loadingWeather = false;
  commit(() => { forecasts = next; }, 'fade');
}
async function reloadStations() {
  if (state.simulateOffline || !navigator.onLine || loadingStations) return;
  loadingStations = true;
  try {
    const result = await stationProvider.load();
    if (state.simulateOffline) return;
    // Merge per fixed ID so a partial/failed response cannot erase the other station.
    state.stations = STATIONS.map(definition => {
      const incoming = result.stations?.find(s => s.id === definition.id), previous = state.stations.find(s => s.id === definition.id);
      if (incoming?.latest) return incoming;
      return { ...(previous || incoming || { ...definition, history: [], latest: null }), error: incoming?.error || result.error || 'Нет измерений' };
    });
    state.stationError = result.error || null;
  } catch (error) {
    state.stationError = error.message;
    state.stations = state.stations.map(s => ({ ...s, error: error.message }));
  } finally { loadingStations = false; }
  recompute(); syncUI();
}
function syncWeatherStatus() {
  $('#refresh-weather').disabled = loadingWeather || !!state.simulateOffline;
  if (loadingWeather) { setText($('#weather-status'), 'Получаем прогноз…'); return; }
  if (state.source === 'demo') { setText($('#weather-status'), 'Демонстрационный прогноз. Оба датчика остаются реальными.'); return; }
  const f = forecasts[0];
  setText($('#weather-status'), f?.modelUpdatedAt ? `GFS27 · модель от ${new Date(f.modelUpdatedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} МСК. ${f.warning ? 'Сбой обновления: сохранён предыдущий ответ.' : ''}` : f?.error || 'Нет прогноза');
}
function syncStationUI() {
  for (const definition of STATIONS) {
    const station = state.stations.find(s => s.id === definition.id), status = stationStatus(station, state.now), row = $(`[data-station="${definition.id}"]`);
    row.setAttribute('aria-pressed', String(state.screen === definition.screen));
    setText(row.querySelector('small'), station?.latest ? `${timeInMoscow(station.latest.timestamp)} МСК · ${status.label}` : status.label);
    setText(row.querySelector('strong'), status.fresh ? `${fmt(station.latest.wind)} м/с` : '—');
  }
  setText($('#station-status'), state.stationError || state.offline ? 'Сбой обновления. Сохранённые измерения продолжают стареть.' : 'Windy.app · обновление раз в минуту · время измерения по Москве');
}
function syncRecommendation() {
  const box = $('#recommendation'), title = $('#recommendation-title'), description = $('#recommendation-description');
  const definition = STATIONS.find(s => s.screen === state.screen);
  if (definition) {
    const station = state.stations.find(s => s.id === definition.id), status = stationStatus(station, state.now);
    setText($('#recommendation-label'), 'ФАКТИЧЕСКОЕ ИЗМЕРЕНИЕ · WINDY.APP');
    setText(title, definition.name);
    setText(description, `${status.label}. ${station?.latest ? `Измерение ${timeInMoscow(station.latest.timestamp)} МСК (${status.ageMinutes ?? '—'} мин назад). ` : ''}${status.fresh ? `${fmt(station.latest.wind)} м/с · ${directionText(station.latest.direction)}. ` : ''}График — последние 6 часов. Измерения относятся к месту установки станции.`);
    box.dataset.kind = status.kind;
  } else {
    const p = state.presentation, best = p.best;
    setText($('#recommendation-label'), 'КРОН · СИЛЬНЕЙШАЯ СЕССИЯ НЕДЕЛИ');
    setText(title, best ? `${dateText(best.date)} · ${pad(best.start)}–${pad(best.end)}` : STATUS_TEXT[p.status] === 'GFS27 М/С' || p.status === 'demo' ? 'Нет полной пары часов' : STATUS_TEXT[p.status]);
    setText(description, best ? `${fmt(best.wind)} м/с · ${directionText(best.direction)}. Максимум средней скорости двух последовательных часов. Неделя начинается завтра. ${p.status === 'offline' ? 'Сбой обновления: сохранённый прогноз.' : ''}` : 'Для выбора нужны два полных часа с известной скоростью. Декабрь–март: 09–22, апрель–ноябрь: световой день внутри 09–22.');
    box.dataset.kind = best ? 'good' : 'unknown';
  }
}
function syncBrightness() {
  const b = brightnessAt(state.settings, new Date(state.now ?? NaN));
  setText($('#display-meta'), `${DISPLAY.fps} FPS · ${b.value}% · ${b.night ? 'НОЧЬ' : 'ДЕНЬ'}`);
  setText($('#effective-brightness'), `${b.value}%`);
  if (b.value !== lastBrightness) { lastBrightness = b.value; renderThumbnails(); }
  return b.value;
}
function renderThumbnails() {
  const brightness = brightnessAt(state.settings, new Date(state.now ?? NaN)).value;
  for (const screen of SCREENS) paintPixels($(`#thumb-${screen.id}`), renderScreen({ ...state, screen: screen.id }, forecasts, flows[screen.id]).dim(brightness));
}
function uiKey() { return JSON.stringify([{ ...state.presentation, now: null }, state.stations.map(s => [s.id, s.latest, s.error, stationStatus(s, state.now)]), state.offline]); }
function syncUI() {
  const screen = SCREENS.find(s => s.id === state.screen);
  setText($('#screen-letter'), screen.key); setText($('#screen-title'), screen.title);
  $$('.screen-tile').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.screen === state.screen)));
  $('#data-source').disabled = !!state.simulateOffline; $('#scenario').disabled = !!state.simulateOffline; $('#data-source').value = state.source; $('#demo-controls').hidden = state.source !== 'demo';
  $('#scenario').value = state.scenario; syncWeatherStatus(); syncStationUI();
  $('#auto-cycle').setAttribute('aria-checked', String(state.auto));
  setText($('#playback-label'), state.auto ? 'Автоцикл · 1 → 2 → 3 → 4 → 5 · 50 с' : 'Экран закреплён · включите автоцикл');
  setText($('#autonomous-time'), pTime());
  $('#brightness').value = state.settings.brightness; setText($('#brightness-output'), `${state.settings.brightness}%`);
  $('#night-brightness').value = state.settings.nightBrightness; setText($('#night-output'), `${state.settings.nightBrightness}%`);
  $('#brightness-mode').value = state.settings.mode; $('#night-start').value = state.settings.nightStart; $('#night-end').value = state.settings.nightEnd;
  setText($('#schedule-hint'), 'Московское время, независимо от часового пояса компьютера.');
  $$('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.settings.view)));
  $('#pixel-display').hidden = state.settings.view !== 'pixel'; $('#led-display').hidden = state.settings.view !== 'led';
  syncRecommendation(); syncBrightness(); renderThumbnails(); lastUIKey = uiKey();
  for (const canvas of [$('#pixel-display'), $('#led-display')]) canvas.setAttribute('aria-label', `${screen.title}. ${$('#recommendation-title').textContent}. ${$('#recommendation-description').textContent}`);
}
function pTime() {
  const p = state.presentation;
  return p.week.length ? `С ${dateText(p.week[0].date)} по ${dateText(p.week.at(-1).date)}. Ближайшие часы: ${p.detail.map(d => pad(d.hour)).join(', ')} МСК.` : 'Нет достоверного времени';
}
$('#screen-grid').innerHTML = SCREENS.map(screen => `<button class="screen-tile" type="button" data-screen="${screen.id}" aria-pressed="false" aria-label="${screen.key}. ${screen.title}" title="${screen.description}"><canvas id="thumb-${screen.id}" width="64" height="64" aria-hidden="true"></canvas><span>${screen.key} · ${screen.short}</span></button>`).join('');
$('#station-readings').innerHTML = STATIONS.map(s => `<button class="station-row" type="button" data-station="${s.id}" aria-pressed="false"><span>${s.name}<br><small></small></span><strong></strong></button>`).join('');
const paletteGradient = WIND_SCALE.map(stop => `rgb(${stop.rgb.map(v => v * 255).join(',')}) ${stop.min / 30 * 100}%`).join(',');
$('#wind-scale').style.setProperty('--wind-gradient', `linear-gradient(to right, ${paletteGradient})`);
$('#wind-scale').innerHTML = WIND_SCALE.filter(stop => [0, 5, 10, 15, 20, 25, 30].includes(stop.min)).map(stop => `<span>${stop.label}</span>`).join('');
function showTab(tab) {
  $$('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('.tab-panel').forEach(panel => panel.hidden = panel.id !== `tab-${tab}`);
}
function setScreen(screen) { showTab(STATIONS.some(s => s.screen === screen) ? 'live' : 'forecast'); commit(() => { state.screen = screen; state.auto = false; }); }
$$('[data-screen]').forEach(button => button.addEventListener('click', () => setScreen(button.dataset.screen)));
$$('[data-station]').forEach(button => button.addEventListener('click', () => setScreen(STATIONS.find(s => s.id === button.dataset.station).screen)));
$$('[data-view]').forEach(button => button.addEventListener('click', () => { commit(() => state.settings.view = button.dataset.view, null); persist(); }));
$$('[data-tab]').forEach(button => {
  button.addEventListener('click', () => showTab(button.dataset.tab));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); const tabs = $$('[data-tab]'), index = tabs.indexOf(button), next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    showTab(next.dataset.tab); next.focus();
  });
});
function toggleAuto() { commit(() => { state.auto = !state.auto; if (state.auto) { cycleStart = performance.now(); state.screen = 'detail'; } }, null); }
$('#auto-cycle').addEventListener('click', toggleAuto);
$('#simulation-time').addEventListener('change', event => {
  commit(() => { state.simulationTime = event.target.value ? Date.parse(`${event.target.value}+03:00`) : null; }, null);
  if (state.source === 'demo') reloadData();
});
$('#clock-known').addEventListener('change', event => commit(() => state.clockKnown = event.target.checked, null));
$('#simulate-offline').addEventListener('change', event => {
  commit(() => { state.simulateOffline = event.target.checked; state.offline = state.simulateOffline || !navigator.onLine; if (state.simulateOffline) { loadVersion++; loadingWeather = false; } }, null);
  if (!state.simulateOffline) { reloadData(); reloadStations(); }
});
window.addEventListener('offline', () => commit(() => state.offline = true, null));
window.addEventListener('online', () => { commit(() => state.offline = !!state.simulateOffline, null); reloadData(); reloadStations(); });
$('#data-source').addEventListener('change', event => { state.source = event.target.value; reloadData(); });
$('#refresh-weather').addEventListener('click', () => { reloadData(); reloadStations(); });
$('#scenario').addEventListener('change', event => { state.scenario = event.target.value; reloadData(); });
for (const [id, setting, numeric] of [['brightness', 'brightness', true], ['night-brightness', 'nightBrightness', true], ['brightness-mode', 'mode', false], ['night-start', 'nightStart', false], ['night-end', 'nightEnd', false]]) {
  $(`#${id}`).addEventListener('input', event => {
    const value = event.target.value;
    if (['nightStart', 'nightEnd'].includes(setting) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return;
    commit(() => state.settings[setting] = numeric ? Number(value) : value, null); persist();
  });
}
$('#export-png').addEventListener('click', () => { downloadPNG(currentFrame, `wind64-${state.screen}-64x64.png`); toast('PNG 64 × 64 сохранён с текущей яркостью'); });
document.addEventListener('keydown', event => {
  if (/INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY/.test(event.target.tagName) || event.metaKey || event.ctrlKey || event.altKey) return;
  if (/^[1-5]$/.test(event.key)) setScreen(SCREENS[Number(event.key) - 1].id);
  if (event.key === ' ') { event.preventDefault(); if (!state.auto) toggleAuto(); }
});
reduceMotion.addEventListener('change', () => { if (reduceMotion.matches) transition = null; });
state.offline = !navigator.onLine; recompute(); syncUI();
function animate(time) {
  requestAnimationFrame(animate);
  const period = 1000 / DISPLAY.fps;
  if (time - lastFrameTime < period) return;
  lastFrameTime = time - (time - lastFrameTime) % period;
  const second = Math.floor(time / 1000), cycle = cycleAt(time - cycleStart);
  if (second !== lastTick || (state.auto && state.screen !== cycle.screen)) {
    lastTick = second;
    if (state.auto && state.screen !== cycle.screen) commit(() => state.screen = cycle.screen);
    else { recompute(); if (uiKey() !== lastUIKey) syncUI(); }
    if (validTime(state.now) && dateInMoscow(state.now) !== lastForecastDate && !loadingWeather) reloadData();
  }
  const began = performance.now(), definition = STATIONS.find(s => s.screen === state.screen);
  if (definition) {
    const station = state.stations.find(s => s.id === definition.id), status = stationStatus(station, state.now);
    flows[state.screen].update(time, { wind: station?.latest?.wind, direction: station?.latest?.direction, enabled: status.fresh, reducedMotion: reduceMotion.matches });
  }
  const target = renderScreen(state, forecasts, flows[state.screen]);
  if (transition) {
    const progress = (time - transition.start) / DISPLAY.transitionMs;
    currentRaw = transitionFrame(transition.from, target, progress, transition.type);
    if (progress >= 1) transition = null;
  } else currentRaw = target;
  currentFrame = currentRaw.dim(syncBrightness());
  if (lastPaintedView !== state.settings.view || !lastPaintedData || currentFrame.data.some((v, i) => v !== lastPaintedData[i])) {
    if (state.settings.view === 'led') paintLED($('#led-display'), currentFrame); else paintPixels($('#pixel-display'), currentFrame);
    lastPaintedView = state.settings.view; lastPaintedData = currentFrame.data.slice(); canvasPaints++;
  }
  const duration = performance.now() - began; totalRenderMs += duration; maxRenderMs = Math.max(maxRenderMs, duration); framesRendered++;
}
requestAnimationFrame(animate); reloadData(); reloadStations();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { recompute(); syncUI(); if (validTime(state.now) && dateInMoscow(state.now) !== lastForecastDate) reloadData(); } });
setInterval(reloadStations, 60000); setInterval(reloadData, 30 * 60000);
// Read-only inspection used by reproducible browser checks and artifact capture.
window.wind64 = Object.freeze({
  getState: () => structuredClone(state), getForecasts: () => structuredClone(forecasts),
  getStats: () => ({ framesRendered, canvasPaints, targetFPS: DISPLAY.fps, averageRenderMs: framesRendered ? totalRenderMs / framesRendered : 0, maxRenderMs }),
  getFrame: () => ({ width: currentFrame.width, height: currentFrame.height, pixels: Array.from(currentFrame.data) }),
  snapshot: screen => renderScreen({ ...state, screen: screen || state.screen }, forecasts, flows[screen || state.screen]).dim(brightnessAt(state.settings, new Date(state.now ?? NaN)).value).rgba(),
});
