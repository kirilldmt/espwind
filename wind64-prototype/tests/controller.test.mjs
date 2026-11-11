import test from 'node:test';
import assert from 'node:assert/strict';
import { KRON, STATIONS, SCREENS } from '../src/config.js';
import { deriveDisplay, ridingHours, sessionsForDay, cycleAt, CYCLE_MS, forecastStatus, sessionHours } from '../src/controller.js';
import { HOUR, addDays, dateInMoscow } from '../src/time.js';
import { circularMean } from '../src/model.js';
import { renderScreen } from '../src/render.js';
import { forecast, moscow, station } from './fixtures.mjs';
const run = (now, change) => deriveDisplay({ forecasts: [forecast(now, change)], now });

test('Nearest hours include night and use ceiling at minute/second boundaries', () => {
  for (const [clock, hours] of [['18:40:00', [19,21,23,1]], ['19:00:00', [19,21,23,1]], ['19:00:01', [20,22,0,2]], ['23:59:59', [0,2,4,6]]]) {
    const p = run(moscow(`2026-12-31T${clock}`));
    assert.deepEqual(p.detail.map(d => d.hour), hours);
    assert.ok(p.detail.every(d => d.slot?.wind === 10));
    assert.equal(p.detail.at(-1).date, '2027-01-01');
  }
});
test('Exactly seven dates start today across midnight, month, year, leap day and season', () => {
  for (const date of ['2026-11-30', '2026-12-31', '2027-03-31', '2027-04-01', '2028-02-28', '2028-02-29']) {
    for (const hour of ['00:00:00', '17:59:00', '18:00:00', '23:59:59']) {
      const now = moscow(`${date}T${hour}`), p = run(now);
      assert.equal(p.week.length, 7); assert.equal(p.week[0].date, date); assert.equal(p.week[6].date, addDays(date, 6));
      assert.ok(p.week.every(d => d.slots.length === 24 && d.slots.every(Boolean)));
    }
  }
  const before = moscow('2026-11-30T23:59:59');
  assert.equal(run(before).week[0].date, '2026-11-30'); assert.equal(run(before + 1000).week[0].date, '2026-12-01');
  assert.equal(dateInMoscow(Date.parse('2026-11-30T21:00:00Z')), '2026-12-01');
});
test('Winter permits full 09–22; shoulder seasons restrict full daylight hours', () => {
  for (const date of ['2026-12-01', '2027-03-31']) assert.deepEqual(ridingHours(KRON, date, moscow(`${date}T08:00:00`)), Array.from({length:13},(_,i)=>9+i));
  for (const date of ['2026-11-30', '2027-04-01']) {
    const hours = ridingHours(KRON, date, moscow(`${date}T08:00:00`));
    assert.ok(hours.length && hours.length < 13); assert.ok(hours[0] >= 9); assert.ok(!hours.includes(21));
  }
  assert.ok(!ridingHours(KRON, '2026-12-01', moscow('2026-12-01T09:00:01')).includes(9));
});
test('Strongest pair wins across the whole week, regardless of gusts/direction/old settings', () => {
  const now = moscow('2026-12-10T18:40:00');
  const p = run(now, ({day,hour}) => day === 5 && [15,16].includes(hour) ? {wind: 30, gust: 90, direction: 90} : {});
  assert.equal(p.best.date, '2026-12-15'); assert.equal(p.best.start, 15); assert.equal(p.best.end, 17); assert.equal(p.best.wind, 30);
  assert.deepEqual(p.bestHours.map(s=>s.hour), [13,15,17,19]);
});
test('Missing speeds/rows split pairs; isolated peaks and nights do not win', () => {
  const now = moscow('2026-12-10T08:00:00'), f = forecast(now, ({hour}) => hour < 9 ? {wind:90} : hour === 11 ? {wind: null} : hour === 12 ? {wind:90} : hour === 13 ? {wind:null} : {});
  f.days[1].slots = f.days[1].slots.filter(s=>s.hour !== 15);
  const sessions = sessionsForDay(KRON, f, f.days[1].date, now);
  assert.equal(sessions[0].wind, 10); assert.ok(sessions.every(s=>![10,11,12,13,14,15].includes(s.start)));
});
test('Tie order is earlier session then nearer date; today is excluded', () => {
  const now = moscow('2026-12-10T08:00:00');
  const p = run(now, ({day,hour}) => day === 0 ? {wind:80} : day === 1 && [12,13].includes(hour) || day >= 2 && [10,11].includes(hour) ? {wind:20} : {});
  assert.equal(p.best.start, 10); assert.equal(p.best.date, '2026-12-12');
  assert.equal(run(now).best.date, '2026-12-11'); assert.equal(run(now).best.start, 9);
});
test('Circular direction handles north, opposed and missing values without excluding speed', () => {
  assert.ok(circularMean([350,10]) < 1e-8); assert.equal(circularMean([0,360]), 0);
  assert.equal(circularMean([90,270]), null); assert.equal(circularMean([null,10]), null);
  const now = moscow('2026-12-10T08:00:00');
  const p = run(now, ({hour})=>({direction: hour % 2 ? 90 : 270}));
  assert.ok(p.best); assert.equal(p.best.direction, null);
});
test('Best row shifts at both boundaries and leaves points outside a short day empty', () => {
  const winter = moscow('2026-12-10T08:00:00'), f = forecast(winter), date = f.days[1].date;
  assert.deepEqual(sessionHours(f, {date,start:9}, winter).map(s=>s.hour), [9,11,13,15]);
  assert.deepEqual(sessionHours(f, {date,start:20}, winter).map(s=>s.hour), [15,17,19,21]);
  const autumn = moscow('2026-11-29T08:00:00'), a = forecast(autumn);
  assert.ok(sessionHours(a, {date: '2026-11-30', start: 10}, autumn).some(s=>s.hour === null));
});
test('Stale forecast suppresses all sessions but preserves hourly and weekly values', () => {
  const now = moscow('2026-12-10T08:00:00'), data = [forecast(now)];
  assert.equal(deriveDisplay({forecasts:data,now:now+HOUR,offline:true}).status,'offline');
  const p=deriveDisplay({forecasts:data,now:now+6*HOUR+1,offline:true});
  assert.equal(p.status,'stale');assert.equal(p.best,null);assert.ok(p.week.every(d=>d.session===null));assert.ok(p.detail[0].slot);
  assert.equal(forecastStatus({...data[0],modelUpdatedAt:now-19*HOUR},now).code,'stale');
});
test('Unknown clock and missing data remain distinct from calm', () => {
  const now=moscow('2026-12-10T08:00:00');
  assert.equal(run(now,()=>({wind:0})).best.wind,0); assert.equal(run(now,()=>({wind:null})).best,null);
  for(const time of [null,NaN,0]) {const p=deriveDisplay({now:time});assert.equal(p.status,'clock');assert.equal(p.best,null);assert.deepEqual(p.week,[]);}
});
test('Autocycle changes exactly every ten seconds and catches up after suspension', () => {
  assert.equal(CYCLE_MS,50000);
  for(let i=0;i<5;i++){assert.equal(cycleAt(i*10000).screen,SCREENS[i].id);assert.equal(cycleAt(i*10000+9999).screen,SCREENS[i].id);}
  assert.equal(cycleAt(50000).screen,'detail');assert.equal(cycleAt(34*CYCLE_MS+40000).screen,'pulkovo');
});
test('Every screen, error, boundary speed and cardinal arrow fits the 64x64 buffer', () => {
  const now=moscow('2026-12-10T08:00:00');
  for(const wind of [0,9.9,19.9,99.9,100,null]) for(const direction of [0,45,90,180,270,350,null]) for(const age of [2,20,45,90]) {
    const data=[forecast(now,()=>({wind,direction}))];
    for(const screen of SCREENS) for(const clock of [now,now+7*HOUR,null]) {
      const frame=renderScreen({screen:screen.id,now:clock,stations:STATIONS.map(d=>station(now,d,{wind:wind??0,direction,ageMinutes:age}))},data);
      assert.equal(frame.clipped,0,`${screen.id}/${wind}/${direction}/${age}`);assert.equal(frame.data.length,12288);
    }
  }
});

test('Best-day session arrow uses circular pair direction and hides an undefined mean', () => {
  const now=moscow('2026-12-10T08:00:00');
  const pixels=frame=>{const out=[];for(let y=57;y<64;y++)for(let x=54;x<64;x++)out.push(...frame.data.slice((y*64+x)*3,(y*64+x)*3+3));return out;};
  const opposed=renderScreen({screen:'best',now},[forecast(now,({hour})=>({direction:hour%2?90:270}))]);
  const north=renderScreen({screen:'best',now},[forecast(now,({hour})=>({direction:hour%2?350:10}))]);
  assert.ok(pixels(opposed).every(v=>v===0));assert.ok(pixels(north).some(v=>v>0));
});
