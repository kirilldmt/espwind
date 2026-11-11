/** Hourly slots describe [timestamp, timestamp + 1h), UTC milliseconds.
 * wind/gust: m/s; direction: meteorological FROM. null is unknown, never zero.
 * Selection needs two known mean speeds; optional gusts and direction do not gate it.
 */
export const knownWind = slot => !!slot && Number.isFinite(slot.wind) && slot.wind >= 0 && slot.wind <= 100;
export const knownDirection = direction => Number.isFinite(direction) && direction >= 0 && direction <= 360;
export function circularMean(directions) {
  if (!directions.length || !directions.every(knownDirection)) return null;
  const sin = directions.reduce((s, d) => s + Math.sin(d * Math.PI / 180), 0);
  const cos = directions.reduce((s, d) => s + Math.cos(d * Math.PI / 180), 0);
  if (Math.hypot(sin, cos) / directions.length < 1e-6) return null;
  const degrees = (Math.atan2(sin, cos) * 180 / Math.PI + 360) % 360;
  return Math.abs(degrees - 360) < 1e-9 ? 0 : degrees;
}
