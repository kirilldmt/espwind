import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherService } from '../weather-service.mjs';
import { STATIONS } from '../src/config.js';
import { HOUR } from '../src/time.js';
import { moscow, windyPayload, stationPayload } from './fixtures.mjs';

test('Forecast cache is fixed to Kron, coalesces requests and refreshes at 30 minutes/Moscow midnight', async () => {
  let now=moscow('2026-11-10T23:40:00'), urls=[];
  const service=createWeatherService({clock:()=>now,fetchJSON:async url=>{urls.push(url);return windyPayload(now);}});
  const [first]=await Promise.all([service.getForecasts(),service.getForecasts()]);assert.equal(urls.length,1);assert.equal(first.length,1);
  const url=new URL(urls[0]);assert.equal(url.searchParams.get('lat'),'60.0111353');assert.equal(url.searchParams.get('models'),'gfs27_long');assert.equal(url.searchParams.get('period'),'1h');
  now+=19*60000;await service.getForecasts();assert.equal(urls.length,1);
  now+=60000;await service.getForecasts();assert.equal(urls.length,2); // date changed before TTL
  now+=30*60000;await service.getForecasts();assert.equal(urls.length,3);
});
test('Forecast failures at midnight and after expiry retain original successful timestamps and values', async () => {
  let now=moscow('2026-11-10T23:59:00'), fail=false;
  const service=createWeatherService({clock:()=>now,fetchJSON:async()=>{if(fail)throw Error('offline');return windyPayload(now);}});
  const first=(await service.getForecasts())[0];fail=true;now+=2*60000;
  const midnight=(await service.getForecasts())[0];assert.equal(midnight.fetchedAt,first.fetchedAt);assert.deepEqual(midnight.days,first.days);assert.equal(midnight.warning,'offline');
  now+=30*HOUR;const stale=(await service.getForecasts())[0];assert.deepEqual(stale.days,first.days);assert.equal(stale.fetchedAt,first.fetchedAt);
});
test('Fixed Windy station requests use predict=0 and independent one-minute caches', async () => {
  let now=moscow('2026-11-10T18:00:00'), failId=null, urls=[];
  const service=createWeatherService({clock:()=>now,fetchJSON:async url=>{urls.push(url);if(url.includes(failId)&&failId)throw Error('offline');return stationPayload(now);}});
  const [first]=await Promise.all([service.getStations(),service.getStations()]);assert.equal(urls.length,2);assert.equal(first.source,'windy');
  for(const url of urls){assert.equal(new URL(url).searchParams.get('predict'),'0');assert.ok(STATIONS.some(s=>url.includes(s.id)));}
  now+=59999;await service.getStations();assert.equal(urls.length,2);now++;
  failId=STATIONS[0].id;const partial=await service.getStations();assert.equal(urls.length,4);assert.ok(partial.stations[0].error);assert.equal(partial.stations[0].latest.timestamp,first.stations[0].latest.timestamp);assert.ok(!partial.stations[1].error);assert.ok(partial.stations[1].latest.timestamp>first.stations[1].latest.timestamp);
  await service.getStations();assert.equal(urls.length,4,'failure also cached to prevent upstream loops');
  now+=60000;failId=null;const recovered=await service.getStations();assert.equal(recovered.error,null);assert.ok(recovered.stations.every(s=>s.history.length>=2));
});
test('Malformed station response cannot erase successful history; first failure has fixed placeholders', async () => {
  let now=moscow('2026-11-10T18:00:00'), broken=true;
  const service=createWeatherService({clock:()=>now,fetchJSON:async()=>broken?{status:'success',response:{data:[]}}:stationPayload(now)});
  let result=await service.getStations();assert.equal(result.stations.length,2);assert.ok(result.stations.every(s=>s.latest===null));
  now+=60000;broken=false;const first=await service.getStations();now+=60000;broken=true;result=await service.getStations();assert.deepEqual(result.stations[0].history,first.stations[0].history);
});
