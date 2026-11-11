import { DISPLAY, FONT_METRICS as M } from './config.js';
import { FONT, textWidth } from './font.js';
export class Framebuffer {
  constructor() { this.width = DISPLAY.width; this.height = DISPLAY.height; this.data = new Uint8ClampedArray(this.width * this.height * 3); this.clipped = 0; }
  pixel(x, y, color) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) { this.clipped++; return; }
    const i = (y * this.width + x) * 3;
    this.data[i] = color[0]; this.data[i + 1] = color[1]; this.data[i + 2] = color[2];
  }
  rect(x, y, width, height, color) { for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) this.pixel(col, row, color); }
  line(x0, y0, x1, y1, color) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    while (true) { this.pixel(x0, y0, color); if (x0 === x1 && y0 === y1) break; const e = 2 * error; if (e >= dy) { error += dy; x0 += sx; } if (e <= dx) { error += dx; y0 += sy; } }
  }
  text(text, x, y, color, scale = 1, verticalScale = scale) {
    for (const [index, char] of [...String(text).toUpperCase()].entries()) {
      const rows = FONT[char] || FONT['?'];
      for (let row = 0; row < M.height; row++) for (let col = 0; col < M.width; col++) if (rows[row] & (1 << (M.width - 1 - col))) this.rect(x + (index * (M.width + M.spacing) + col) * scale, y + Math.round(row * verticalScale), scale, Math.round((row + 1) * verticalScale) - Math.round(row * verticalScale), color);
    }
  }
  center(text, x, y, width, color, scale = 1) { this.text(text, x + Math.floor((width - textWidth(String(text), scale)) / 2), y, color, scale); }
  arrow(cx, cy, direction, color, radius = DISPLAY.arrowRadius) {
    if (!Number.isFinite(direction)) { this.line(cx - 2, cy, cx + 2, cy, color); return; }
    // Arrow points TO the destination: a northerly wind blows down the screen.
    const rad = (direction + 180) * Math.PI / 180, dx = Math.sin(rad), dy = -Math.cos(rad);
    const tip = [cx + dx * radius, cy + dy * radius];
    this.line(cx - dx * radius, cy - dy * radius, ...tip, color);
    const wing = Math.max(2, Math.round(radius * 0.7));
    this.line(...tip, tip[0] - dx * wing - dy * wing, tip[1] - dy * wing + dx * wing, color);
    this.line(...tip, tip[0] - dx * wing + dy * wing, tip[1] - dy * wing - dx * wing, color);
  }
  clone() { const next = new Framebuffer(); next.data.set(this.data); return next; }
  dim(percent) { const next = new Framebuffer(); for (let i = 0; i < this.data.length; i++) next.data[i] = Math.round(this.data[i] * percent / 100); return next; }
  rgba() {
    const rgba = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0, j = 0; i < this.data.length; i += 3, j += 4) { rgba[j] = this.data[i]; rgba[j + 1] = this.data[i + 1]; rgba[j + 2] = this.data[i + 2]; rgba[j + 3] = 255; }
    return rgba;
  }
}
export function transitionFrame(from, to, progress, type = 'slide', direction = 1) {
  if (progress >= 1) return to;
  if (progress <= 0) return from;
  const frame = new Framebuffer();
  const p = progress * progress * (3 - 2 * progress);
  if (type === 'fade') { for (let i = 0; i < frame.data.length; i++) frame.data[i] = Math.round(from.data[i] * (1 - p) + to.data[i] * p); return frame; }
  const offset = Math.round(DISPLAY.width * p);
  for (let y = 0; y < DISPLAY.height; y++) for (let x = 0; x < DISPLAY.width; x++) {
    const sourceX = x + offset * direction;
    const old = sourceX >= 0 && sourceX < DISPLAY.width;
    const sx = (sourceX + DISPLAY.width) % DISPLAY.width;
    const data = old ? from.data : to.data;
    const i = (y * DISPLAY.width + sx) * 3, dest = (y * DISPLAY.width + x) * 3;
    frame.data[dest] = data[i]; frame.data[dest + 1] = data[i + 1]; frame.data[dest + 2] = data[i + 2];
  }
  return frame;
}
