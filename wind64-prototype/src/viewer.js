import { DISPLAY } from './config.js';
export function paintPixels(canvas, frame) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.putImageData(new ImageData(frame.rgba(), DISPLAY.width, DISPLAY.height), 0, 0);
}
export function paintLED(canvas, frame) {
  const ctx = canvas.getContext('2d'), s = DISPLAY.ledScale;
  ctx.fillStyle = '#030609'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < DISPLAY.height; y++) for (let x = 0; x < DISPLAY.width; x++) {
    const i = (y * DISPLAY.width + x) * 3;
    const [r, g, b] = frame.data.subarray(i, i + 3);
    ctx.fillStyle = r + g + b ? `rgb(${r} ${g} ${b})` : '#0c1118';
    ctx.beginPath(); ctx.arc(x * s + s / 2, y * s + s / 2, DISPLAY.ledRadius, 0, Math.PI * 2); ctx.fill();
  }
}
export function downloadPNG(frame, filename) {
  const canvas = document.createElement('canvas'); canvas.width = DISPLAY.width; canvas.height = DISPLAY.height;
  paintPixels(canvas, frame);
  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/png');
}
