'use strict';

// #2919: compression for static assets and JSON (SSE / NDJSON excluded), a
// one-year immutable cache for the content-hashed /assets/*, and no-cache for
// index.html. Exercised against a real express app mounted the way api.js
// mounts it, plus a source-reading guard for that wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');
const rateLimit = require('express-rate-limit');

const {
  IMMUTABLE_CACHE_CONTROL, INDEX_CACHE_CONTROL,
  isStreamingContentType, createCompressionMiddleware, setStaticCacheHeaders,
} = require('./http-delivery');

const BIG_JS = 'export const x = ' + JSON.stringify('abc'.repeat(20000)) + ';\n';
const BIG_JSON = { rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `row-${i}` })) };

function buildApp(staticDir) {
  const app = express();
  app.use(createCompressionMiddleware());
  app.use(express.static(staticDir, { setHeaders: setStaticCacheHeaders }));
  app.get('/api/big', (req, res) => res.json(BIG_JSON));
  app.get('/api/sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write('data: first\n\n');
    // The stream stays open; the test closes the connection after event one.
    req.on('close', () => res.end());
  });
  app.get('/api/ndjson', (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.flushHeaders();
    res.write(JSON.stringify({ step: 1 }) + '\n');
    req.on('close', () => res.end());
  });
  // Mirrors api.js's spaLimiter (CodeQL js/missing-rate-limiting on sendFile).
  const spaLimiter = rateLimit({ windowMs: 60_000, max: 3000, standardHeaders: true, legacyHeaders: false });
  app.get('*path', spaLimiter, (req, res) => {
    res.setHeader('Cache-Control', INDEX_CACHE_CONTROL);
    res.sendFile(path.join(staticDir, 'index.html'));
  });
  return app;
}

let server;
let base;
let staticDir;

test.before(async () => {
  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-delivery-'));
  fs.mkdirSync(path.join(staticDir, 'assets'));
  fs.writeFileSync(path.join(staticDir, 'assets', 'index-abc123.js'), BIG_JS);
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><script src="/assets/index-abc123.js"></script>');
  fs.writeFileSync(path.join(staticDir, 'favicon.svg'), '<svg/>');
  server = buildApp(staticDir).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(staticDir, { recursive: true, force: true });
});

// Raw GET (no automatic decompression) resolving with headers + body buffer.
function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + urlPath, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// Resolves with the headers and first body chunk of a never-ending response —
// proof that the middleware did not buffer it.
function firstChunk(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + urlPath, { headers }, (res) => {
      const timer = setTimeout(() => { req.destroy(); reject(new Error('stream was buffered: no chunk within 2s')); }, 2000);
      res.once('data', (chunk) => {
        clearTimeout(timer);
        resolve({ headers: res.headers, chunk: chunk.toString('utf8') });
        req.destroy();
      });
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
  });
}

test('hashed /assets/*.js is served gzip-encoded when the client accepts gzip', async () => {
  const res = await get('/assets/index-abc123.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.ok(res.body.length < BIG_JS.length / 10, `expected a real size win, got ${res.body.length} bytes`);
  assert.equal(zlib.gunzipSync(res.body).toString('utf8'), BIG_JS);
});

test('brotli is preferred when the client offers gzip and br', async () => {
  const res = await get('/assets/index-abc123.js', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(res.headers['content-encoding'], 'br');
  assert.equal(zlib.brotliDecompressSync(res.body).toString('utf8'), BIG_JS);
});

test('large /api JSON responses are compressed', async () => {
  const res = await get('/api/big', { 'Accept-Encoding': 'gzip' });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(zlib.gunzipSync(res.body).toString('utf8')), BIG_JSON);
});

test('nothing is compressed for a client that does not ask for it', async () => {
  const res = await get('/assets/index-abc123.js');
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(res.body.toString('utf8'), BIG_JS);
});

test('/assets/* carries a one-year immutable Cache-Control', async () => {
  const res = await get('/assets/index-abc123.js');
  assert.equal(res.headers['cache-control'], IMMUTABLE_CACHE_CONTROL);
  assert.match(res.headers['cache-control'], /max-age=31536000/);
  assert.match(res.headers['cache-control'], /immutable/);
});

test('index.html is never cached long-term — static root, explicit path and SPA fallback', async () => {
  for (const urlPath of ['/', '/index.html', '/chats']) {
    const res = await get(urlPath);
    assert.equal(res.status, 200, urlPath);
    assert.equal(res.headers['cache-control'], INDEX_CACHE_CONTROL, urlPath);
    assert.match(res.body.toString('utf8'), /index-abc123\.js/, urlPath);
  }
});

test('other dist files keep the default revalidating cache policy', async () => {
  const res = await get('/favicon.svg');
  assert.equal(res.headers['cache-control'], 'public, max-age=0');
});

test('SSE streams are not compressed and their first event arrives without waiting for the end', async () => {
  const { headers, chunk } = await firstChunk('/api/sse', { 'Accept-Encoding': 'gzip, br' });
  assert.equal(headers['content-encoding'], undefined);
  assert.equal(chunk, 'data: first\n\n');
});

test('NDJSON progress streams are not compressed either', async () => {
  const { headers, chunk } = await firstChunk('/api/ndjson', { 'Accept-Encoding': 'gzip, br' });
  assert.equal(headers['content-encoding'], undefined);
  assert.equal(chunk, '{"step":1}\n');
});

test('isStreamingContentType ignores parameters and case', () => {
  assert.equal(isStreamingContentType('text/event-stream'), true);
  assert.equal(isStreamingContentType('Text/Event-Stream; charset=utf-8'), true);
  assert.equal(isStreamingContentType('application/x-ndjson; charset=utf-8'), true);
  assert.equal(isStreamingContentType('application/json; charset=utf-8'), false);
  assert.equal(isStreamingContentType(undefined), false);
});

test('api.js mounts compression before the static handler and caches index.html as no-cache', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const compressAt = SRC.indexOf('app.use(createCompressionMiddleware());');
  const staticAt = SRC.indexOf('app.use(express.static(STATIC_DIR, { setHeaders: setStaticCacheHeaders }));');
  assert.notEqual(compressAt, -1, 'compression middleware is not wired');
  assert.notEqual(staticAt, -1, 'static handler lost its cache headers');
  assert.ok(compressAt < staticAt, 'compression must wrap the static handler');
  const fallbackAt = SRC.indexOf("app.get('*path', spaLimiter,");
  assert.notEqual(fallbackAt, -1, 'SPA fallback moved — re-anchor this guard');
  const fallback = SRC.slice(fallbackAt, SRC.indexOf('\n});', fallbackAt));
  assert.match(fallback, /res\.setHeader\('Cache-Control', INDEX_CACHE_CONTROL\);\s*res\.sendFile\(/);
});
