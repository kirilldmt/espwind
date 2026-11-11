export const DISPLAY = Object.freeze({ width: 64, height: 64, fps: 25, transitionMs: 400, pulseMs: 2400, ledScale: 8, ledRadius: 2.65, arrowRadius: 4 });
export const FONT_METRICS = Object.freeze({ width: 3, height: 5, spacing: 1 });
export const COLORS = {
  background: [0, 0, 0], white: [228, 242, 245], muted: [115, 146, 166], line: [23, 39, 50],
  accent: [78, 223, 195], good: [99, 230, 155], caution: [255, 188, 84], bad: [255, 100, 111], unknown: [101, 116, 134], ink: [5, 14, 22],
};
// Verified 2026-11-10 against the current official map and forecast bundles.
// Source values, hashes and LED opacity/high-end decisions: docs/PALETTE.md.
// Interpolate normalized RGB before rounding; opacity belongs to the map overlay.
const WINDY_RGB = [
  [0, 0.941, 0.957, 0.961],
  [2, 0.776, 0.89, 0.961],
  [5, 0.184, 0.855, 0.788],
  [6, 0.125, 0.812, 0.09],
  [10, 0.937, 0.89, 0.106],
  [12, 0.831, 0.557, 0.157],
  [15, 0.98, 0.255, 0.118],
  [17, 0.725, 0.137, 0.353],
  [20, 0.518, 0.106, 0.545],
  [22, 0.38, 0.137, 0.561],
  [25, 0.192, 0.071, 0.282],
  [30, 0.098, 0.035, 0.141],
];
export const WIND_SCALE = Object.freeze(WINDY_RGB.map(([min, ...rgb]) => Object.freeze({
  min, rgb: Object.freeze(rgb), color: Object.freeze(rgb.map(v => Math.round(v * 255))), label: min === 30 ? '30+' : String(min),
})));
export function windColor(speed) {
  if (!Number.isFinite(speed) || speed < 0) return COLORS.unknown;
  const last = WIND_SCALE.at(-1);
  if (speed >= last.min) return last.color;
  const upper = WIND_SCALE.findIndex(stop => stop.min > speed);
  const low = WIND_SCALE[upper - 1], high = WIND_SCALE[upper];
  const fraction = (speed - low.min) / (high.min - low.min);
  return low.rgb.map((v, i) => Math.round((v + (high.rgb[i] - v) * fraction) * 255));
}
function luminance(color) {
  return color.reduce((sum, value, i) => {
    const c = value / 255, linear = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}
export function windTextColor(speed) {
  const background = luminance(windColor(speed));
  return (luminance(COLORS.white) + 0.05) / (background + 0.05) > (background + 0.05) / (luminance(COLORS.ink) + 0.05) ? COLORS.white : COLORS.ink;
}
export const SCREENS = Object.freeze([
  { id: 'detail', key: '1', title: 'Ближайшие часы', short: 'Часы', description: 'Крон · четыре точки с шагом два часа, включая ночь.' },
  { id: 'week', key: '2', title: 'Неделя', short: 'Неделя', description: 'Сегодня и шесть следующих дней · все 24 часа.' },
  { id: 'best', key: '3', title: 'Лучший день недели', short: 'Лучший', description: 'Самая сильная двухчасовая сессия за неделю.' },
  { id: 'kitepiter', key: '4', title: 'KITEPITER', short: 'Kitepiter', description: 'Измерения Windy.app и история за шесть часов.' },
  { id: 'pulkovo', key: '5', title: 'PULKOVO', short: 'Pulkovo', description: 'Измерения Windy.app и история за шесть часов.' },
]);
export const DAY_LABELS = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];
export const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
export const DIRECTIONS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
export const KRON = Object.freeze({ id: 'kro', windyId: '585111', name: 'Крон', short: 'КРОН', lat: 60.0111353, lon: 29.6915455, url: 'https://windy.app/forecast2/spot/585111' });
export const DEFAULT_SPOTS = Object.freeze([KRON]);
export const STATIONS = Object.freeze([
  Object.freeze({ id: '1chipru_840d8eaa9b63', screen: 'kitepiter', name: 'KITEPITER', warningMinutes: 15, staleMinutes: 30, gapMinutes: 15 }),
  Object.freeze({ id: 'ULLI', screen: 'pulkovo', name: 'PULKOVO', warningMinutes: 60, staleMinutes: 90, gapMinutes: 45 }),
]);
export const DEFAULT_SETTINGS = { brightness: 80, nightBrightness: 12, mode: 'schedule', nightStart: '23:00', nightEnd: '07:00', view: 'led' };
