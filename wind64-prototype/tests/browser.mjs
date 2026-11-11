import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { STATIONS, SCREENS } from '../src/config.js';
import { forecast, station, moscow } from './fixtures.mjs';
const root = new URL('..', import.meta.url).pathname, artifacts = `${root}/artifacts/v4`;
const port=6470, base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let browser;
const errors=[];
const start=moscow('2026-12-10T18:40:00');
function example(now) { return forecast(now,({day,hour})=>({ wind: day === 3 && hour>=12 && hour<=16 ? 16+Math.sin(hour) : 5+day+Math.sin(hour/3)*2, direction: day===3 ? 350 : 230, ...(day===4&&hour===3 ? {wind:null,direction:null} : {}) })); }
try {
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('Test server failed');})]);
  browser=await chromium.launch({channel:'chrome',headless:true});await mkdir(artifacts,{recursive:true});
  const context=await browser.newContext({viewport:{width:1440,height:1100},timezoneId:'America/Los_Angeles',reducedMotion:'reduce'});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:start});await page.clock.pauseAt(start);
  await page.addInitScript(()=>{if(!localStorage.getItem('wind64.settings.v2'))localStorage.setItem('wind64.settings.v2',JSON.stringify({spots:[{id:'extra'}],stationId:'0261',settings:{brightness:80,nightBrightness:12,mode:'schedule',view:'pixel'}}));});
  let forecastRequests=0, stationRequests=0;
  await page.route('**/api/forecast',async route=>{forecastRequests++;await route.fulfill({json:{forecasts:[example(await page.evaluate(()=>Date.now()))]}});});
  await page.route('**/api/stations',async route=>{stationRequests++;const now=await page.evaluate(()=>Date.now());await route.fulfill({json:{source:'windy',stations:STATIONS.map(d=>station(now,d,{gap:true}))}});});
  await page.goto(base);await page.waitForFunction(()=>wind64?.getForecasts()[0].fetchedAt && wind64.getState().stations.length===2);
  const get=()=>page.evaluate(()=>wind64.getState());
  assert.equal((await get()).screen,'detail');assert.equal((await get()).auto,true);assert.equal((await get()).spots.length,1);assert.equal((await get()).stationId,undefined);
  assert.equal(await page.locator('#spot-select,#station-select,#spots-form,#min-window').count(),0);
  assert.equal(await page.locator('[data-screen]').count(),5);assert.equal(await page.locator('[data-station]').count(),2);
  assert.deepEqual((await get()).presentation.detail.map(d=>d.hour),[19,21,23,1]);
  assert.equal((await get()).presentation.week[0].date,'2026-12-10');
  await page.clock.runFor(100); // allow the 25-FPS frame to observe a boundary
  for(const s of SCREENS.slice(1)){await page.clock.runFor(10000);assert.equal((await get()).screen,s.id);}
  await page.clock.runFor(10000);assert.equal((await get()).screen,'detail');
  const stationCount=stationRequests;await page.clock.runFor(10001);await page.waitForFunction(()=>wind64.getState().stations[0].latest.timestamp>Date.parse('2026-12-10T18:38:00+03:00'));assert.ok(stationRequests>stationCount);
  // Manually pinned screen and migrated display preferences survive with auto reset on restart.
  await page.locator('[data-screen="pulkovo"]').click();assert.equal((await get()).auto,false);
  await page.locator('[data-tab="display"]').click();await page.locator('#brightness').fill('67');await page.locator('#brightness').dispatchEvent('input');
  await page.reload();await page.waitForFunction(()=>wind64?.getState().stations.length===2);
  assert.equal((await get()).settings.brightness,67);assert.equal((await get()).settings.view,'pixel');assert.equal((await get()).screen,'detail');assert.equal((await get()).auto,true);
  // Refreshing rows must not disturb scroll or focus.
  await page.setViewportSize({width:1440,height:760});await page.locator('[data-screen="kitepiter"]').click();
  const row=page.locator(`[data-station="${STATIONS[0].id}"]`);await row.focus();await page.evaluate(()=>scrollTo(0,150));const scroll=await page.evaluate(()=>scrollY);
  await page.clock.fastForward(61000);await page.clock.runFor(1100);assert.equal(await page.evaluate(()=>scrollY),scroll);assert.equal(await row.evaluate(e=>e===document.activeElement),true);
  // Midnight requests a new eight-day forecast even when TTL has not elapsed.
  await page.locator('[data-screen="detail"]').click();await page.locator('details:has(#simulation-time) summary').click();
  await page.locator('#simulation-time').fill('2026-12-31T23:59');await page.locator('#simulation-time').dispatchEvent('change');await page.clock.runFor(1100);
  const before=forecastRequests;await page.locator('#simulation-time').fill('2027-01-01T00:00');await page.locator('#simulation-time').dispatchEvent('change');await page.clock.runFor(1100);
  assert.ok(forecastRequests>before);assert.equal((await get()).presentation.week[0].date,'2027-01-01');
  await page.locator('#simulation-time').fill('');await page.locator('#simulation-time').dispatchEvent('change');await page.clock.runFor(1100);
  // A dropped network preserves both data sets and allows their clocks to expire.
  await page.locator('#simulate-offline').check();const count=forecastRequests;const stationsBefore=(await get()).stations;
  assert.equal((await get()).presentation.status,'offline');
  await page.clock.fastForward(7*3600000);await page.clock.runFor(1100);
  assert.equal((await get()).presentation.status,'stale');assert.equal((await get()).presentation.best,null);assert.equal(forecastRequests,count);assert.deepEqual((await get()).stations,stationsBefore);
  assert.equal(await page.locator('#effective-brightness').textContent(),'12%');
  await page.locator('#clock-known').uncheck();assert.equal((await get()).presentation.status,'clock');
  await page.setViewportSize({width:390,height:844});await page.clock.runFor(80);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.close();

  // Artifact session: normal animation timers, fixed Moscow wall clock, isolated synthetic weather.
  const captureContext=await browser.newContext({viewport:{width:1440,height:1100},timezoneId:'Europe/Moscow',reducedMotion:'no-preference'});
  const capture=await captureContext.newPage();capture.on('pageerror',e=>errors.push(e.message));
  await capture.clock.setFixedTime(start);
  await capture.route('**/api/forecast',route=>route.fulfill({json:{forecasts:[example(start)]}}));
  await capture.route('**/api/stations',route=>route.fulfill({json:{source:'windy',stations:STATIONS.map(d=>station(start,d,{wind:d.id==='ULLI'?7.2:9.5,gap:true}))}}));
  await capture.goto(base);await capture.waitForFunction(()=>wind64?.getState().stations.length===2 && wind64.getState().presentation.best);
  await capture.locator('[data-view="pixel"]').click();
  const pngs=[];
  for(const screen of SCREENS){
    await capture.locator(`[data-screen="${screen.id}"]`).click();
    if (screen.key === '4' || screen.key === '5') await capture.waitForTimeout(1800);
    const png=await capture.evaluate(screen=>{const c=document.createElement('canvas');c.width=c.height=64;c.getContext('2d').putImageData(new ImageData(wind64.snapshot(screen),64,64),0,0);return c.toDataURL().split(',')[1];},screen.id);
    pngs.push(png);await writeFile(`${artifacts}/${screen.key}-${screen.id}-64x64.png`,Buffer.from(png,'base64'));
  }
  const sheet=await capture.evaluate(async ({pngs,labels})=>{
    const c=document.createElement('canvas');c.width=5*288;c.height=324;const ctx=c.getContext('2d');ctx.fillStyle='#0c121b';ctx.fillRect(0,0,c.width,c.height);ctx.imageSmoothingEnabled=false;
    for(let i=0;i<pngs.length;i++){const im=new Image();im.src='data:image/png;base64,'+pngs[i];await im.decode();ctx.drawImage(im,i*288+16,48,256,256);ctx.font='16px sans-serif';ctx.fillStyle='#dce7ef';ctx.fillText(labels[i],i*288+16,28);}
    return c.toDataURL().split(',')[1];
  },{pngs,labels:SCREENS.map(s=>`${s.key}. ${s.title}`)});
  await writeFile(`${artifacts}/five-screens.png`,Buffer.from(sheet,'base64'));
  await capture.locator('[data-screen="detail"]').click();await capture.waitForTimeout(450);await capture.screenshot({path:`${artifacts}/desktop.png`,fullPage:true});
  await capture.setViewportSize({width:390,height:844});assert.equal(await capture.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);const mobileHeight=await capture.evaluate(()=>document.documentElement.scrollHeight);await capture.setViewportSize({width:390,height:mobileHeight});await capture.waitForTimeout(120);await capture.screenshot({path:`${artifacts}/mobile.png`});await capture.setViewportSize({width:1440,height:1100});
  // Both viewers consume the same framebuffer; validate the LED canvas is painted too.
  await capture.locator('[data-view="led"]').click();await capture.waitForTimeout(120);
  assert.equal(await capture.locator('#led-display').isVisible(),true);
  assert.ok(await capture.evaluate(()=>document.querySelector('#led-display').getContext('2d').getImageData(0,0,512,512).data.some((v,i)=>i%4!==3&&v>50)));
  await capture.screenshot({path:`${artifacts}/desktop-led.png`,fullPage:true});
  await capture.locator('[data-view="pixel"]').click();
  // Check a live particle frame changes, then honors the OS reduced-motion setting.
  await capture.locator('[data-screen="kitepiter"]').click();await capture.waitForTimeout(900);
  const moving=await capture.evaluate(()=>wind64.getFrame().pixels);await capture.waitForTimeout(240);assert.notDeepEqual(await capture.evaluate(()=>wind64.getFrame().pixels),moving);
  await capture.emulateMedia({reducedMotion:'reduce'});await capture.waitForTimeout(120);const still=await capture.evaluate(()=>wind64.getFrame().pixels);await capture.waitForTimeout(240);assert.deepEqual(await capture.evaluate(()=>wind64.getFrame().pixels),still);
  await capture.emulateMedia({reducedMotion:'no-preference'});
  // Night frames use the same RGB dimming as the preview and export.
  await capture.locator('[data-tab="display"]').click();await capture.locator('#brightness-mode').selectOption('night');
  const night=await capture.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=64;c.getContext('2d').putImageData(new ImageData(wind64.snapshot('kitepiter'),64,64),0,0);return c.toDataURL().split(',')[1];});
  await writeFile(`${artifacts}/4-kitepiter-night-64x64.png`,Buffer.from(night,'base64'));await capture.locator('#brightness-mode').selectOption('day');
  // 51 seconds records a full five-screen cycle with both sensor animations in actual time.
  await capture.locator('[data-screen="detail"]').click();await capture.locator('#auto-cycle').click();
  console.log('Browser assertions passed; recording the 51-second five-screen cycle…');
  const recording=await capture.evaluate(async()=>{
    const out=document.createElement('canvas');out.width=out.height=512;const ctx=out.getContext('2d');ctx.imageSmoothingEnabled=false;
    const draw=()=>ctx.drawImage(document.querySelector('#pixel-display'),0,0,512,512);draw();const timer=setInterval(draw,40);
    const stream=out.captureStream(25), recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:1600000}), chunks=[];
    recorder.ondataavailable=e=>chunks.push(e.data);const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();await new Promise(resolve=>setTimeout(resolve,51000));recorder.stop();await stopped;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());
    const blob=new Blob(chunks,{type:'video/webm'});return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(blob);});
  });
  await writeFile(`${artifacts}/five-screen-cycle.webm`,Buffer.from(recording,'base64'));
  const stats=await capture.evaluate(()=>wind64.getStats());assert.ok(stats.averageRenderMs<40,`Render budget: ${stats.averageRenderMs}ms`);
  assert.deepEqual(errors,[]);
  const report={passed:true,timezone:'America/Los_Angeles',forecastRequests,stationRequests,checks:['50-second cycle','next full hour + 2h','seven days starting today','fixed spot/stations and legacy migration','brightness persistence','station refresh and focus','Moscow midnight refresh','offline aging','night brightness','unknown clock','390px layout','LED and pixel views','five PNGs','particle animation/reduced motion','51-second WebM'],stats,consoleErrors:errors};
  await writeFile(`${artifacts}/browser-check.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();server.kill();}
