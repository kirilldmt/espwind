import { windColor } from './config.js';
import { knownDirection } from './model.js';
export function flowVelocity(wind, direction, enabled = true) {
  if (!enabled || !Number.isFinite(wind) || wind <= 0 || !knownDirection(direction)) return { x: 0, y: 0 };
  const radians = direction * Math.PI / 180, speed = Math.min(36, wind * 1.4);
  return { x: -Math.sin(radians) * speed, y: Math.cos(radians) * speed };
}
const wrap = value => (value % 64 + 64) % 64;
export class ParticleFlow {
  constructor(seed = 1) {
    let randomState = seed;
    const random = () => ((randomState = Math.imul(randomState, 1664525) + 1013904223 >>> 0) / 4294967296);
    this.points = Array.from({ length: 64 }, () => ({ x: random() * 64, y: random() * 64, glow: 0.6 + random() * 0.4 }));
    this.velocity = { x: 0, y: 0 }; this.color = windColor(0); this.lastTime = null;
  }
  update(time, { wind, direction, enabled = true, reducedMotion = false } = {}) {
    const dt = this.lastTime === null ? 0 : Math.max(0, Math.min(0.1, (time - this.lastTime) / 1000));
    this.lastTime = time;
    const target = flowVelocity(wind, direction, enabled && !reducedMotion), moving = target.x !== 0 || target.y !== 0;
    const ease = 1 - Math.exp(-dt / 0.75), color = windColor(wind);
    for (const axis of ['x', 'y']) this.velocity[axis] = moving ? this.velocity[axis] + (target[axis] - this.velocity[axis]) * ease : 0;
    this.color = reducedMotion ? color : this.color.map((v, i) => v + (color[i] - v) * ease);
    for (const point of this.points) { point.x = wrap(point.x + this.velocity.x * dt); point.y = wrap(point.y + this.velocity.y * dt); }
    return this;
  }
  draw(frame) {
    const speed = Math.hypot(this.velocity.x, this.velocity.y), dx = speed ? this.velocity.x / speed : 0, dy = speed ? this.velocity.y / speed : 0;
    for (const p of this.points) for (let tail = 0; tail < (speed > 0.1 ? 5 : 1); tail++) {
      const x = wrap(p.x - dx * tail), y = wrap(p.y - dy * tail), ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
      // Bilinear splats make subpixel movement smooth on the actual 64x64 buffer.
      for (const [ox, oy, weight] of [[0, 0, (1-fx)*(1-fy)], [1, 0, fx*(1-fy)], [0, 1, (1-fx)*fy], [1, 1, fx*fy]]) {
        const px = (ix + ox) % 64, py = (iy + oy) % 64, i = (py * 64 + px) * 3;
        frame.pixel(px, py, this.color.map((v, c) => frame.data[i + c] + v * weight * p.glow * (5 - tail) / 5 * 0.3));
      }
    }
  }
}
