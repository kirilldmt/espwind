import { HOUR, validTime } from './time.js';
import { STATIONS } from './config.js';
import { knownWind } from './model.js';
// Pixel columns contain observation means, never last-value wins or interpolated data.
export function historyGraph(station, now, width = 53) {
  if (!validTime(now)) return { start: null, end: null, max: 10, columns: [] };
  const start = now - 6 * HOUR, end = now;
  const gap = (STATIONS.find(s => s.id === station?.id)?.gapMinutes || 15) * 60000;
  const rows = (station?.history || []).filter(r => r.timestamp >= start && r.timestamp <= end).sort((a, b) => a.timestamp - b.timestamp);
  const columns = []; let previous = null, segment = 0;
  for (const row of rows) {
    if (!knownWind(row)) { previous = null; segment++; continue; }
    if (previous && row.timestamp - previous.timestamp > gap) segment++;
    const x = Math.min(width - 1, Math.floor((row.timestamp - start) / (end - start) * (width - 1)));
    const last = columns.at(-1);
    if (last?.x === x) {
      // A break inside one pixel cannot be drawn as two values: average the column,
      // but disconnect both sides so it cannot conceal an outage.
      if (last.segment !== segment) last.segment = null;
      last.sum += row.wind; last.count++; last.wind = last.sum / last.count; last.lastAt = row.timestamp;
    } else columns.push({ x, wind: row.wind, sum: row.wind, count: 1, firstAt: row.timestamp, lastAt: row.timestamp, segment });
    previous = row;
  }
  return { start, end, max: Math.max(10, Math.ceil(Math.max(0, ...columns.map(c => c.wind)) / 5) * 5), columns };
}
