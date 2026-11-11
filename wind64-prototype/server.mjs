import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { getForecasts, getStations } from './weather-service.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 6464);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8', '.json': 'application/json' };
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(data)); };
    if (pathname === '/api/stations' && req.method === 'GET') { json(200, await getStations()); return; }
    if (pathname === '/api/forecast' && req.method === 'POST') {
      // Browser requests stay same-origin. No arbitrary proxy URL or credentials accepted.
      if (req.headers.origin && !['http://127.0.0.1:' + port, 'http://localhost:' + port].includes(req.headers.origin)) { json(403, { error: 'Недопустимый источник запроса' }); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16000) { json(413, { error: 'Слишком большой запрос' }); return; } }
      let payload; try { payload = JSON.parse(body); } catch { json(400, { error: 'Неверный JSON' }); return; }
      // Coordinates and station IDs are fixed server-side; legacy requests cannot restore other spots.
      json(200, { forecasts: await getForecasts() }); return;
    }
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`WIND64 · http://127.0.0.1:${port}`));
