import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COLORS, WIND_SCALE, windColor, windTextColor, DEFAULT_SPOTS, SCREENS, STATIONS } from '../src/config.js';
import { DemoForecastProvider } from '../src/provider.js';
import { deriveDisplay } from '../src/controller.js';
import { renderScreen } from '../src/render.js';
const reference = JSON.parse(await readFile(new URL('../docs/windy-palette-reference.json', import.meta.url), 'utf8'));

test('Wind RGB anchors match the independently captured official m/s tables', () => {
  assert.equal(reference.units, 'm/s'); assert.equal(reference.sources.length, 2);
  assert.deepEqual(WIND_SCALE.map(s => [s.min, ...s.rgb]), reference.stops.filter(s => s.min <= 30).map(s => [s.min, ...s.rgba.slice(0, 3)]));
  for (const stop of reference.stops.filter(s => s.min <= 30)) assert.deepEqual(windColor(stop.min), stop.rgba.slice(0, 3).map(c => Math.round(c * 255)));
  assert.deepEqual(windColor(15), [250, 65, 30]);
});
test('Linear transitions keep normalized source precision until final RGB8 rounding', () => {
  const checkpoints = [[3.5,[122,222,223]], [5.5,[39,213,112]], [8,[135,217,25]], [11,[225,184,34]], [13.5,[231,104,35]], [16,[217,50,60]], [18.5,[158,31,114]], [21,[114,31,141]], [23.5,[73,27,107]], [27.5,[37,14,54]]];
  for (const [speed, rgb] of checkpoints) assert.deepEqual(windColor(speed), rgb, String(speed));
});
test('Unknown wind stays distinct from calm; high wind never fades to transparent black', () => {
  for (const speed of [null, undefined, NaN, Infinity, -1]) assert.deepEqual(windColor(speed), COLORS.unknown);
  assert.notDeepEqual(windColor(0), COLORS.unknown);
  for (const speed of [30, 35, 40, 100]) assert.deepEqual(windColor(speed), [25, 9, 36]);
});
test('Dark purple cells use light numbers; light cells use dark numbers', () => {
  assert.deepEqual(windTextColor(0), COLORS.ink); assert.deepEqual(windTextColor(10), COLORS.ink);
  assert.deepEqual(windTextColor(20), COLORS.white); assert.deepEqual(windTextColor(30), COLORS.white);
});
test('All five screens render the same speed color without clipping', async () => {
  const now = Date.parse('2026-12-10T08:00:00+03:00');
  const spots = DEFAULT_SPOTS.map(s => ({ ...s, conditionsConfirmed: true, minWind: 1, maxWind: 40, maxGust: 60 }));
  for (const speed of [6, 15, 25]) {
    const forecasts = await new DemoForecastProvider().load(spots, { now });
    for (const f of forecasts) for (const d of f.days) for (const s of d.slots) { s.wind = speed; s.gust = speed + 1; }
    const presentation = deriveDisplay({ spots, forecasts, now });
    const station = { id: STATIONS[0].id, latest: { wind: speed, direction: 230, timestamp: now - 60000 }, history: [] };
    station.history.push(station.latest);
    for (const screen of SCREENS) {
      const frame = renderScreen({ screen: screen.id, spots, presentation, now, stations: STATIONS.map(s => ({ ...station, ...s })) }, forecasts);
      assert.equal(frame.clipped, 0);
      const color = windColor(speed);
      assert.ok(frame.data.some((_, i) => i % 3 === 0 && color.every((v, k) => frame.data[i + k] === v)), `${screen.id}/${speed}`);
    }
  }
});
