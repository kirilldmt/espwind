import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {forecast,station,moscow} from '../../wind64-prototype/tests/fixtures.mjs';
import {renderScreen} from '../../wind64-prototype/src/render.js';
import {deriveDisplay,ridingHours} from '../../wind64-prototype/src/controller.js';
import {historyGraph} from '../../wind64-prototype/src/history-graph.js';
import {KRON,STATIONS,SCREENS} from '../../wind64-prototype/src/config.js';
import {atHour,addDays,dateInMoscow} from '../../wind64-prototype/src/time.js';
import {getTimes} from '../../wind64-prototype/node_modules/suncalc/index.js';
import {ParticleFlow} from '../../wind64-prototype/src/particles.js';
import {stationStatus} from '../../wind64-prototype/src/weather.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const build=root+'firmware/build/native';mkdirSync(build,{recursive:true});
const exe=build+'/wind64-native';
const compile=spawnSync('clang++',['-std=c++17','-Wall','-Wextra','-Werror','-I',root+'firmware/wind64','-I',root+'.tools/arduino-user/libraries/ArduinoJson/src',root+'firmware/tests/native.cpp',root+'firmware/wind64/core.cpp',root+'firmware/wind64/weather_parser.cpp',root+'firmware/wind64/polling.cpp','-o',exe],{encoding:'utf8'});
assert.equal(compile.status,0,compile.stderr);
const checks=spawnSync(exe,[],{encoding:'utf8'});assert.equal(checks.status,0,checks.stdout+checks.stderr);
const cases=[];
for(const date of ['2026-11-11T00:10:30','2026-12-31T23:59:59','2027-01-01T00:00:00','2028-02-29T23:00:00','2026-03-31T22:59:59','2026-04-01T07:00:00','2026-06-20T19:00:00','2026-09-23T18:40:00'])cases.push({name:date.replaceAll(':','-'),now:moscow(date)});
for(const special of ['missing','stale','offline','partial','null-latest','zero','100','opposed','delayed','no-clock'])cases.push({name:special,now:moscow('2026-11-11T00:10:30'),special});
for(const direction of [0,90,180,270,null])cases.push({name:'flow-'+direction,now:moscow('2026-11-11T00:10:30'),flow:true,direction});
let frames=0;
for(const c of cases){
  const f=forecast(c.now,({day,hour})=>({wind:3+((day*7+hour*3)%26)/2,direction:(day*49+hour*37)%360}));
  const stations=STATIONS.map(d=>station(c.now,d,{gap:true}));let offline=false,now=c.now;
  if(c.special==='missing')f.days.forEach(d=>d.slots.forEach(s=>s.wind=null));
  if(c.special==='stale'){f.fetchedAt=now-7*3600000;stations.forEach(s=>s.history.forEach(r=>r.timestamp-=2*3600000));}
  if(c.special==='offline')offline=true;
  if(c.special==='partial'){f.warning='network';stations[0].error='network';for(const d of f.days)d.slots[12].wind=null;}
  if(c.special==='null-latest'){stations.forEach(s=>s.history.at(-1).wind=null);}
  if(c.special==='zero'||c.special==='100'){const n=Number(c.special==='zero'?0:100);f.days.forEach(d=>d.slots.forEach(s=>s.wind=n));stations.forEach(s=>s.history.forEach(r=>r.wind=n));}
  if(c.special==='opposed')f.days.forEach(d=>d.slots.forEach((s,i)=>s.direction=i%2?180:0));
  if(c.special==='delayed')stations.forEach((s,i)=>s.history.forEach(r=>r.timestamp-=(i?60:15)*60000));
  if(c.special==='no-clock')now=0;
  if(c.flow)stations.forEach(s=>s.history.forEach(r=>r.direction=c.direction));
  const flows=stations.map((s,i)=>{const flow=new ParticleFlow(i+1);if(c.flow)for(let t=0;t<=1000;t+=40)flow.update(t,{wind:s.latest.wind,direction:s.latest.direction,enabled:stationStatus(s,now).fresh});return flow;});
  const source={now,base:atHour(f.days[0].date,0),fetchedAt:f.fetchedAt,modelAt:f.modelUpdatedAt,error:!!f.warning,offline,flow:!!c.flow,hours:f.days.flatMap(d=>d.slots),stations:stations.map(s=>({...s,error:!!s.error}))};
  const prefix=build+'/'+c.name;writeFileSync(prefix+'.json',JSON.stringify(source));const run=spawnSync(exe,[prefix+'.json',prefix],{encoding:'utf8'});assert.equal(run.status,0,`${c.name}: ${run.stderr}`);const actual=JSON.parse(run.stdout);
  const p=deriveDisplay({forecasts:[f],now,offline});assert.equal(actual.bestHour,p.best?.start??-1,c.name+' best hour');assert.equal(actual.bestDay,p.best?atHour(p.best.date,0):0,c.name+' best day');
  if(p.best)assert.ok(Math.abs(actual.bestWind-p.best.wind)<1e-8);
  if(now)for(let day=0;day<7;day++){const date=addDays(dateInMoscow(now),day+1),expected=getTimes(new Date(atHour(date,12)),KRON.lat,KRON.lon,0,180);assert.deepEqual(actual.days[day].hours,ridingHours(KRON,date,now),c.name+' riding hours');for(const [a,b] of [['rise','sunrise'],['set','sunset']])assert.ok(Math.abs(actual.days[day][a]-(+expected[b]||0))<=2,c.name+' sun '+a);}
  for(let screen=0;screen<5;screen++){const js=renderScreen({screen:SCREENS[screen].id,now,offline,stations},[f],c.flow&&screen>=3?flows[screen-3]:null);const cpp=readFileSync(prefix+'-'+screen+'.rgb');assert.equal(cpp.length,js.data.length);const diff=[];for(let i=0;i<cpp.length;i++)if(cpp[i]!==js.data[i]){if(diff.length<6)diff.push({pixel:Math.floor(i/3),channel:i%3,cpp:cpp[i],js:js.data[i]});}assert.equal(diff.length,0,`${c.name} screen ${screen+1}: ${JSON.stringify(diff)}`);frames++;}
  for(let i=0;i<2;i++){const graph=historyGraph(stations[i],now);assert.equal(actual.graphs[i].max,graph.max);assert.equal(actual.graphs[i].count,graph.columns.length);}
}
console.log(JSON.stringify({cases:cases.length,identicalFrames:frames,solarToleranceMs:2,status:'passed'}));
