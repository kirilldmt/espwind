import { COLORS as C, DAY_LABELS, STATIONS, windColor, windTextColor } from './config.js';
import { Framebuffer } from './framebuffer.js';
import { deriveDisplay, STATUS_TEXT } from './controller.js';
import { HOUR, hourInMoscow, timeInMoscow, validTime } from './time.js';
import { textWidth } from './font.js';
import { knownDirection } from './model.js';
import { stationStatus } from './weather.js';
import { historyGraph } from './history-graph.js';
const num = n => Number.isFinite(n) ? String(Math.min(99, Math.round(n))) : '--';
const pad = n => n == null ? '--' : String(n).padStart(2, '0');
const shortDate = date => date ? `${date.slice(8)}.${date.slice(5, 7)}` : '--';
const dayName = date => DAY_LABELS[new Date(`${date}T12:00:00Z`).getUTCDay()];
const header = (f, label, right = '') => { f.rect(0, 0, 64, 8, C.background); f.text(label, 2, 1, C.white); f.text(right, 64 - right.length * 4, 1, C.accent); f.line(1, 7, 62, 7, C.line); };
const hasWarning = status => !['fresh', 'demo'].includes(status);
const footer = (f, status) => { if (hasWarning(status)) f.center(STATUS_TEXT[status] || 'НЕТ ДАННЫХ', 0, 59, 64, C.caution); };
const arrow = (f, x, y, direction, radius = 5) => { if (knownDirection(direction)) f.arrow(x, y, direction, C.white, radius); };
function columns(f, points, compact, fullHeight = false) {
  points.forEach(({ hour, slot }, i) => {
    const x = 2 + i * 15, value = num(slot?.wind);
    f.text(pad(hour), x + 3, 11, C.white, 1, 1.4);
    arrow(f, x + 6, 26, slot?.direction, 6);
    f.rect(x, 35, 14, fullHeight ? (compact ? 21 : 27) : (compact ? 15 : 20), windColor(slot?.wind));
    f.text(value, x + Math.floor((14 - textWidth(value, 2)) / 2), fullHeight ? 41 : 37, windTextColor(slot?.wind), 2, compact ? 2 : 3);
  });
}
function drawHistory(f, graph, warning) {
  const left = 10, top = warning ? 39 : 33, bottom = 55;
  // The removed unit/status rows become extra vertical space for history.
  f.rect(0, top - 2, 64, 66 - top, C.background);
  f.line(left, top, 62, top, C.line); f.line(left, bottom, 62, bottom, C.line);
  f.text(String(graph.max), 0, top, C.muted); f.text('0', 4, 51, C.muted);
  const y = c => bottom - Math.round(c.wind / graph.max * (bottom - top));
  graph.columns.forEach((column, index) => {
    const previous = graph.columns[index - 1];
    if (column.segment !== null && previous?.segment === column.segment) f.line(left + previous.x, y(previous), left + column.x, y(column), windColor(column.wind));
    f.pixel(left + column.x, y(column), windColor(column.wind));
  });
  if (graph.start !== null) {
    const ticks = [];
    for (let timestamp = Math.ceil(graph.start / HOUR) * HOUR; timestamp <= graph.end; timestamp += HOUR) {
      const x = left + Math.round((timestamp - graph.start) / (graph.end - graph.start) * 52);
      ticks.push({ x, label: pad(hourInMoscow(timestamp)), labelX: Math.min(57, x - 3) });
    }
    // Keep seven labels readable even when the last full hour touches the right edge.
    for (let i = ticks.length - 2; i >= 0; i--) ticks[i].labelX = Math.min(ticks[i].labelX, ticks[i + 1].labelX - 8);
    for (const tick of ticks) {
      f.pixel(tick.x, 56, C.muted);
      f.text(tick.label, tick.labelX, 59, C.muted);
    }
  }
}
export function renderScreen(state, forecasts = [], flow = null) {
  const f = new Framebuffer(), definition = STATIONS.find(s => s.screen === state.screen);
  if (definition) {
    const station = state.stations?.find(s => s.id === definition.id), status = stationStatus(station, state.now);
    flow?.draw(f);
    header(f, definition.name, validTime(station?.latest?.timestamp) ? timeInMoscow(station.latest.timestamp) : '--:--');
    const warning = station?.error || state.offline ? 'НЕТ СЕТИ' : status.kind === 'caution' ? 'ЗАДЕРЖКА' : null;
    if (status.fresh) {
      const row = station.latest, value = row.wind.toFixed(1), scale = value.length > 4 ? 2 : 3;
      f.text(value, Math.floor((46 - textWidth(value, scale)) / 2), 13, windColor(row.wind), scale, 3);
      if (row.wind > 0) arrow(f, 55, 21, row.direction, 6);
    } else f.center(status.label.toUpperCase(), 0, 19, 64, C.caution);
    if (warning) f.center(warning, 0, 30, 64, C.caution);
    drawHistory(f, state.graphs?.[definition.id] || historyGraph(station, state.now), !!warning);
    return f;
  }
  const p = state.presentation || deriveDisplay({ ...state, forecasts });
  if (p.status === 'clock') { header(f, 'КРОН'); f.center('НЕТ ВРЕМЕНИ', 0, 25, 64, C.caution); return f; }
  const compact = hasWarning(p.status), captionY = compact ? 52 : 58;
  if (state.screen === 'detail') {
    header(f, 'КРОН', shortDate(p.detail[0]?.date)); columns(f, p.detail, compact, true);
    footer(f, p.status);
  } else if (state.screen === 'week') {
    header(f, 'КРОН', 'НЕДЕЛЯ');
    p.week.forEach(({ date, session, slots }, i) => {
      const y = 9 + i * (compact ? 7 : 8);
      f.text(dayName(date), 1, y, i ? C.muted : C.white);
      arrow(f, 12, y + 2, session?.direction, 2);
      slots.forEach((slot, hour) => {
        const x = 16 + hour * 2;
        f.rect(x, y, 2, compact ? 5 : 6, Number.isFinite(slot?.wind) ? windColor(slot.wind) : C.line);
        if (!Number.isFinite(slot?.wind)) f.pixel(x, y + 2, C.unknown);
      });
    });
    footer(f, p.status);
  } else if (state.screen === 'best') {
    const best = p.best;
    if (!best) {
      header(f, 'ЛУЧШИЙ ДЕНЬ'); f.center(p.status === 'stale' ? 'УСТАРЕЛО' : 'НЕТ ПОЛНОЙ', 0, 25, 64, C.caution);
      f.center(p.status === 'stale' ? 'ПРОГНОЗ' : 'ПАРЫ ЧАСОВ', 0, 37, 64, C.muted);
    } else {
      header(f, dayName(best.date), shortDate(best.date)); columns(f, p.bestHours, compact);
      f.text(`СЕССИЯ ${pad(best.start)}-${pad(best.end)}`, 2, captionY, C.accent);
      arrow(f, 58, captionY + 2, best.direction, 2);
    }
    footer(f, p.status);
  }
  return f;
}
