import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWindy, normalizeStation, stationStatus, directionFromUV } from '../src/weather.js';
import { KRON, STATIONS } from '../src/config.js';
import { historyGraph } from '../src/history-graph.js';
import { HOUR } from '../src/time.js';
import { moscow, windyPayload, stationPayload, station } from './fixtures.mjs';
const now=moscow('2026-11-10T18:00:00');

test('Windy preserves eight full Moscow days and hourly UTC timestamps; gusts are optional', () => {
  const f=normalizeWindy(windyPayload(now),KRON,{now});
  assert.equal(f.days.length,8);assert.equal(f.days[7].date,'2026-11-17');assert.ok(f.days.every(d=>d.slots.length===24));
  assert.equal(f.days[0].slots[0].wind,5);assert.equal(f.days[0].slots[0].gust,null);assert.equal(f.days[0].slots[0].timestamp,moscow('2026-11-10T00:00:00'));
});
test('Missing forecast hour remains null; duplicates, wrong zone/model and old model reject', () => {
  const p=windyPayload(now);p.response.forecast.splice(1,1);
  assert.equal(normalizeWindy(p,KRON,{now}).days[0].slots[1].wind,null);
  for(const mutate of [p=>p.status='error',p=>p.response.timezone='UTC',p=>p.response.available_models=['ecmwf'],p=>p.response.modelsUpdateTime.gfs27-=19*3600,p=>p.response.forecast.push(p.response.forecast[0])]) {
    const data=windyPayload(now);mutate(data);assert.throws(()=>normalizeWindy(data,KRON,{now}));
  }
  assert.equal(directionFromUV(0,-5),0);assert.equal(directionFromUV(-5,0),90);
});
test('Windy station parser keeps zero, null gust/min and unknown direction, sorts and deduplicates', () => {
  const p=stationPayload(now,0);p.response.data[0].wind_direction=null;
  p.response.data.push({timestamp:now/1000-600,wind_avg:8,wind_min:6,wind_max:11,wind_direction:360});
  p.response.data.push({...p.response.data[0]});
  const s=normalizeStation(p,STATIONS[1],now);
  assert.equal(s.history.length,2);assert.equal(s.latest.wind,0);assert.equal(s.latest.gust,null);assert.equal(s.latest.min,null);assert.equal(s.latest.direction,null);assert.equal(s.history[0].direction,0);
  assert.equal(stationStatus(s,now).fresh,true);
});
test('Missing latest mean is unknown, never the previous valid reading; future/malformed timestamps reject', () => {
  const p=stationPayload(now,8);p.response.data.push({timestamp:now/1000,wind_avg:null,wind_direction:0});
  const s=normalizeStation(p,STATIONS[0],now);assert.equal(s.latest.wind,null);assert.equal(stationStatus(s,now).fresh,false);
  for(const timestamp of [null,0,now/1000+600]) {const p=stationPayload(now);p.response.data[0].timestamp=timestamp;assert.throws(()=>normalizeStation(p,STATIONS[0],now));}
});
test('Freshness thresholds follow each station cadence exactly, independent of fetchedAt', () => {
  for(const d of STATIONS) {
    const s=station(now,d,{ageMinutes:0});s.fetchedAt=now+HOUR;
    assert.equal(stationStatus(s,now+d.warningMinutes*60000-1).kind,'good');
    assert.equal(stationStatus(s,now+d.warningMinutes*60000).kind,'caution');
    assert.equal(stationStatus(s,now+d.staleMinutes*60000-1).fresh,true);
    assert.equal(stationStatus(s,now+d.staleMinutes*60000).fresh,false);
  }
});
test('History uses fixed six-hour domain, zero baseline and ceil-to-five scale', () => {
  const s=station(now,STATIONS[0],{wind:11,ageMinutes:20}), g=historyGraph(s,now);
  assert.equal(g.start,now-6*HOUR);assert.equal(g.end,now);assert.equal(g.max,15);
  assert.ok(g.columns.at(-1).x<52,'right edge stays empty when late');
  const calm={id:STATIONS[0].id,history:[{timestamp:now,wind:0}]};
  assert.equal(historyGraph(calm,now).max,10);assert.equal(historyGraph(calm,now).columns[0].wind,0);
  assert.equal(historyGraph(s,now+10*HOUR).columns.length,0);
});
test('All samples in one pixel column are averaged; outside-domain readings cannot affect scale', () => {
  const history=[{timestamp:now-6*HOUR-1,wind:90},{timestamp:now-300000,wind:4},{timestamp:now-240000,wind:8},{timestamp:now+1,wind:95}];
  const g=historyGraph({history},now);assert.equal(g.columns.length,1);assert.equal(g.columns[0].count,2);assert.equal(g.columns[0].wind,6);assert.equal(g.max,10);
});
test('Gaps over 15/45 minutes and missing means break history, exact thresholds connect', () => {
  for(const definition of STATIONS) for(const extra of [0,1]) {
    const g=historyGraph({id:definition.id,history:[{timestamp:now-definition.gapMinutes*60000-extra,wind:3},{timestamp:now,wind:7}]},now);
    assert.equal(g.columns[0].segment===g.columns[1].segment,extra===0);
  }
  const g=historyGraph({history:[{timestamp:now-600000,wind:5},{timestamp:now-300000,wind:null},{timestamp:now,wind:7}]},now);
  assert.notEqual(g.columns[0].segment,g.columns[1].segment);
});

// A missing observation can fall between two measurements mapped to the same pixel.
test('One column still averages all speeds across a missing observation, without bridging it', () => {
  const g=historyGraph({history:[{timestamp:now-300000,wind:4},{timestamp:now-270000,wind:null},{timestamp:now-240000,wind:8},{timestamp:now,wind:6}]},now);
  assert.equal(g.columns.length,2);assert.equal(g.columns[0].wind,6);assert.equal(g.columns[0].segment,null);assert.notEqual(g.columns[0].segment,g.columns[1].segment);
});
