import test from 'node:test';
import assert from 'node:assert/strict';
import { Framebuffer, transitionFrame } from '../src/framebuffer.js';
import { initialState, brightnessAt, saveState } from '../src/state.js';
import { KRON } from '../src/config.js';

test('Brightness acts on RGB bytes including zero, preserving source buffer', () => {
  const f=new Framebuffer();f.pixel(0,0,[200,100,50]);assert.deepEqual([...f.dim(50).data.slice(0,3)],[100,50,25]);assert.ok(f.dim(0).data.every(v=>v===0));assert.deepEqual([...f.data.slice(0,3)],[200,100,50]);
});
test('Moscow brightness honors boundaries, equal times, day intervals and unknown clock', () => {
  const s=initialState().settings, at=t=>new Date(`2026-11-10T${t}:00+03:00`);
  for(const [time,value] of [['22:59',80],['23:00',12],['00:00',12],['06:59',12],['07:00',80]]) assert.equal(brightnessAt(s,at(time)).value,value);
  assert.equal(brightnessAt({...s,nightStart:'10:00',nightEnd:'16:00'},at('12:00')).value,12);
  assert.equal(brightnessAt({...s,nightEnd:'23:00'},at('23:00')).value,80);
  assert.equal(brightnessAt({...s,brightness:5},at('23:00')).value,5);
  assert.equal(brightnessAt(s,new Date(NaN)).value,12);
});
test('Transitions have exact endpoints and never leave the grid', () => {
  const a=new Framebuffer(), b=new Framebuffer();a.rect(0,0,64,64,[255,0,0]);b.rect(0,0,64,64,[0,255,0]);
  for(const direction of [-1,1]) for(const type of ['slide','fade']) {
    assert.deepEqual(transitionFrame(a,b,0,type,direction).data,a.data);assert.deepEqual(transitionFrame(a,b,1,type,direction).data,b.data);assert.equal(transitionFrame(a,b,0.5,type,direction).clipped,0);
  }
});
test('Legacy settings retain display preferences only, never extra spots or old station/screens', () => {
  let json=JSON.stringify({spots:[{id:'custom',name:'Elsewhere'}],stationId:'0261',screen:'live',settings:{brightness:63,nightBrightness:8,mode:'schedule',view:'pixel',nightStart:'21:30',nightEnd:'06:15',minWindowHours:13}});
  const storage={getItem:()=>json,setItem:(_,value)=>json=value};
  const a=initialState(storage);assert.deepEqual(a.spots,[KRON]);assert.equal(a.stationId,undefined);assert.equal(a.screen,'detail');assert.equal(a.auto,true);assert.equal(a.settings.brightness,63);assert.equal(a.settings.view,'pixel');assert.equal(a.settings.minWindowHours,undefined);
  saveState(a,storage);assert.deepEqual(Object.keys(JSON.parse(json)),['settings']);const b=initialState(storage);assert.deepEqual(b.settings,a.settings);
  assert.equal(initialState({getItem:()=>'{bad'}).settings.brightness,80);
  assert.equal(initialState({getItem:()=>JSON.stringify({settings:{brightness:999,nightStart:'99:88'}})}).settings.brightness,80);
});
