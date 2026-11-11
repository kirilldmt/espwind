import { HOURS, DEFAULT_SPOTS } from './config.js';
import { dateInMoscow, atHour } from './time.js';
export class WindyForecastProvider {
  async load() {
    const response = await fetch('/api/forecast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}), signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`Не удалось получить прогноз: HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.forecasts) || payload.forecasts.length !== DEFAULT_SPOTS.length) throw new Error('Неполный ответ локального сервера');
    return payload.forecasts;
  }
}
export class WindyStationProvider {
  async load() {
    const response = await fetch('/api/stations', { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Не удалось получить датчики: HTTP ${response.status}`);
    return response.json();
  }
}
const round = value => Math.round(value * 10) / 10;
// Deterministic fixtures: reloading does not randomize conditions.
export class DemoForecastProvider {
  async load(spots, { scenario = 'mixed', now = Date.now(), baseDate = dateInMoscow(now) } = {}) {
    return spots.map((spot, index) => ({
      spotId: spot.id, timezone: 'Europe/Moscow', source: 'demo', fetchedAt: now, modelUpdatedAt: now,
      days: Array.from({ length: 8 }, (_, day) => {
        const date = new Date(`${baseDate}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() + day);
        const key = date.toISOString().slice(0, 10);
        return { date: key, slots: HOURS.map(hour => ({ ...this.slot(index, day, hour, scenario), timestamp: atHour(key, hour) })) };
      }),
    }));
  }
  slot(index, day, hour, scenario) {
    const bases = [[8, 10, 4, 13, 9, 17, 8], [11, 8, 5, 12, 10, 16, 9], [7, 9, 3, 11, 8, 15, 7]];
    const swell = Math.sin((hour - 6) / 24 * Math.PI * 2) * 1.6;
    let wind = round(Math.max(0, bases[index % 3][day % 7] + swell));
    let gust = round(wind * (index === 1 && day === 0 ? 1.7 : 1.18) + 0.6);
    let direction = (index === 2 ? 310 : 230) + (day % 3) * 15 + (hour - 12);
    if (day === 3) direction = 80;
    if (scenario === 'mixed' && day === 4 && index === 2) return { hour, wind: null, gust: null, direction: null };
    if (day === 5) gust = round(wind * 1.65);
    if (scenario === 'calm') { wind = round(1.5 + index % 3 + hour / 24); gust = round(wind + 1); }
    if (scenario === 'good') { wind = round(8 + index * 0.6 + swell * 0.3); gust = round(wind * 1.2); direction = index === 2 ? 315 : 230; }
    if (scenario === 'gusts') { wind = 10 + index; gust = 23 + index * 2; }
    if (scenario === 'direction') { wind = 9 + index; gust = 12 + index; direction = 90; }
    if (scenario === 'missing') return { hour, wind: null, gust: null, direction: null };
    return { hour, wind, gust, direction: (direction + 360) % 360 };
  }
}
