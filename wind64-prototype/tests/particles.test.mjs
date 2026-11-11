import test from 'node:test';
import assert from 'node:assert/strict';
import { flowVelocity, ParticleFlow } from '../src/particles.js';
import { Framebuffer } from '../src/framebuffer.js';
test('Particles move TO: north goes down, east left, south up, west right', () => {
  for(const [direction,x,y] of [[0,0,1],[90,-1,0],[180,0,-1],[270,1,0]]) {
    const v=flowVelocity(10,direction);assert.ok(Math.abs(v.x-x*14)<1e-10);assert.ok(Math.abs(v.y-y*14)<1e-10);
  }
  assert.ok(Math.hypot(...Object.values(flowVelocity(15,45)))>Math.hypot(...Object.values(flowVelocity(5,45))));
});
test('Calm, unknown direction, stale data and reduced motion stop movement immediately', () => {
  for(const change of [{wind:0},{direction:null},{enabled:false},{reducedMotion:true}]) {
    const f=new ParticleFlow();f.update(0,{wind:10,direction:0});f.update(40,{wind:10,direction:0});const points=structuredClone(f.points);
    for(let i=2;i<30;i++)f.update(i*40,{wind:10,direction:0,...change});assert.deepEqual(f.points,points);assert.deepEqual(f.velocity,{x:0,y:0});
  }
});
test('Wind changes ease velocities, wrap around the framebuffer and never clip', () => {
  const f=new ParticleFlow();f.update(0,{wind:10,direction:90});for(let i=1;i<100;i++)f.update(i*40,{wind:10,direction:90});
  assert.ok(f.velocity.x<-13);f.update(4000,{wind:10,direction:270});assert.ok(f.velocity.x<0,'no sudden direction jump');
  for(let i=101;i<400;i++)f.update(i*40,{wind:10,direction:270});assert.ok(f.velocity.x>13);
  const frame=new Framebuffer();f.draw(frame);assert.equal(frame.clipped,0);assert.ok(frame.data.some(v=>v>0));assert.ok(f.points.every(p=>p.x>=0&&p.x<64&&p.y>=0&&p.y<64));
});
test('Reduced motion produces a stable frame at unchanged wind', () => {
  const flow=new ParticleFlow();flow.update(0,{wind:10,direction:0,reducedMotion:true});const a=new Framebuffer();flow.draw(a);
  flow.update(5000,{wind:10,direction:0,reducedMotion:true});const b=new Framebuffer();flow.draw(b);assert.deepEqual(a.data,b.data);
});
