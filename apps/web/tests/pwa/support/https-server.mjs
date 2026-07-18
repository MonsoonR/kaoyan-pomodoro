import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { extname, join, normalize } from 'node:path';
import selfsigned from 'selfsigned';

const certificate = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
  algorithm: 'sha256',
  days: 1,
  keySize: 2048,
  extensions: [{ name: 'subjectAltName', altNames: [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ] }],
});
const root = join(import.meta.dirname, '../../../dist');
const webPort = Number(process.env.KAOYAN_E2E_WEB_PORT ?? 4173);
const apiPort = Number(process.env.KAOYAN_E2E_API_PORT ?? 4174);
const types = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

createServer({ key: certificate.private, cert: certificate.cert }, (request, response) => {
  if ((request.url ?? '').startsWith('/api/')) {
    const proxy = httpRequest({
      host: '127.0.0.1', port: apiPort, method: request.method, path: request.url,
      headers: { ...request.headers, host: `127.0.0.1:${apiPort}` },
    }, (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(response);
    });
    proxy.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(proxy);
    return;
  }
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'https://localhost').pathname);
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  let file = join(root, relative || 'index.html');
  try { if (!statSync(file).isFile()) file = join(root, 'index.html'); }
  catch { file = join(root, 'index.html'); }
  const name = file.slice(root.length + 1).replaceAll('\\', '/');
  const immutable = name.startsWith('assets/') && /-[A-Za-z0-9_-]{8,}\./.test(name);
  const noCache = name === 'index.html' || name === 'sw.js' || name.endsWith('.webmanifest') || name.startsWith('workbox-');
  response.writeHead(200, {
    'content-type': types[extname(file)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : noCache ? 'no-cache' : 'public, max-age=3600',
  });
  createReadStream(file).pipe(response);
}).listen(webPort, '127.0.0.1');
