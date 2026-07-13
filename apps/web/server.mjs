import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, 'dist');
const port = Number(process.env.PORT ?? 8080);
const types = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end('{"status":"ok"}');
    return;
  }
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://web').pathname);
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  let file = join(root, relative || 'index.html');
  try {
    if (!statSync(file).isFile()) file = join(root, 'index.html');
  } catch {
    file = join(root, 'index.html');
  }
  const name = file.slice(root.length + 1).replaceAll('\\', '/');
  const immutable = name.startsWith('assets/') && /-[A-Za-z0-9_-]{8,}\./.test(name);
  const updateSensitive = name === 'index.html' || name === 'sw.js' || name.endsWith('.webmanifest') || name.startsWith('workbox-');
  response.writeHead(200, {
    'content-type': types[extname(file)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : updateSensitive ? 'no-cache' : 'public, max-age=3600',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
}).listen(port, '0.0.0.0');
