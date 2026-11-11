// Optional live readback and video inspection. Requires npm start on port 6464.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const root=new URL('..',import.meta.url).pathname, base='http://127.0.0.1:6464';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1100},timezoneId:'Europe/Moscow'}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>window.wind64?.getForecasts()[0].fetchedAt && wind64.getState().stations.length===2,{},{timeout:45000});
  const data=await page.evaluate(()=>({state:wind64.getState(),forecasts:wind64.getForecasts()}));
  assert.equal(data.state.spots.length,1);assert.equal(data.forecasts[0].model,'GFS27');assert.deepEqual(data.state.stations.map(s=>s.id),['1chipru_840d8eaa9b63','ULLI']);
  await page.locator('[data-screen="kitepiter"]').click();await page.waitForTimeout(800);await page.screenshot({path:`${root}/artifacts/v4/live-kitepiter-led.png`,fullPage:true});
  const report={checkedAt:new Date().toISOString(),timezone:'Europe/Moscow',model:data.forecasts[0].model,forecastHours:data.forecasts[0].days.reduce((n,d)=>n+d.slots.filter(s=>s.wind!==null).length,0),stations:data.state.stations.map(s=>({id:s.id,latest:s.latest,records:s.history.length,error:s.error})),brightness:data.state.settings,consoleErrors:errors};
  await page.goto(`${base}/artifacts/v4/index.html`);
  const video=await page.evaluate(async()=>{
    const v=document.querySelector('video');v.pause();v.src=URL.createObjectURL(await (await fetch(v.src)).blob());v.load();if(v.readyState<1)await new Promise((resolve,reject)=>{v.addEventListener('loadedmetadata',resolve,{once:true});v.addEventListener('error',reject,{once:true});});
    const c=document.createElement('canvas');c.width=5*272;c.height=296;const ctx=c.getContext('2d');ctx.fillStyle='#0c121b';ctx.fillRect(0,0,c.width,c.height);ctx.imageSmoothingEnabled=false;
    const times=[1,11,21,31,41], actualTimes=[];
    for(const [i,t] of times.entries()) {
      const seeked=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Video seek timeout')),10000);v.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});});v.currentTime=t;await seeked;
      await v.play();await new Promise(resolve=>setTimeout(resolve,180));v.pause();actualTimes.push(v.currentTime);
      ctx.drawImage(v,i*272+8,32,256,256);ctx.fillStyle='#e3ebf2';ctx.font='16px sans-serif';ctx.fillText(`Экран ${i+1} · ${t} c`,i*272+8,22);
    }
    return {width:v.videoWidth,height:v.videoHeight,duration:Number.isFinite(v.duration)?v.duration:null,seekTimes:times,actualTimes,png:c.toDataURL().split(',')[1]};
  });
  assert.equal(video.width,512);assert.equal(video.height,512);
  assert.ok(video.duration>=50 && video.duration<=52);
  assert.ok(video.actualTimes.every((t,i)=>Math.abs(t-video.seekTimes[i])<1));
  await writeFile(`${root}/artifacts/v4/video-frames.png`,Buffer.from(video.png,'base64'));
  report.video={...video,png:undefined};assert.deepEqual(errors,[]);
  await writeFile(`${root}/artifacts/v4/live-browser-check.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
