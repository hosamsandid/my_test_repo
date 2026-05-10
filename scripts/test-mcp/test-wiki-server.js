#!/usr/bin/env node
'use strict';

// Black-box test of mcp-servers/wiki/server.js.
//
// Strategy: spawn the server as a subprocess, inject a mock backend by
// pointing WIKI_BASE_URL at a localhost HTTP server we run inside this
// process, then drive the MCP stdio protocol through the child's stdin /
// stdout. No third-party deps.

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const assert = require('assert');

const SERVER = path.resolve(__dirname, '..', '..', 'mcp-servers', 'wiki', 'server.js');

let pass = 0, fail = 0;
function ok(msg)   { pass++; console.log(`  [32mok[0m  ${msg}`); }
function bad(msg, err) { fail++; console.log(`  [31mfail[0m ${msg}\n      ${err}`); }

function startMockBackend() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // `/search?q=…&limit=…`  → fixed result set
      if (req.url.startsWith('/search')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          results: [
            { id: 'p1', title: 'Hello world', snippet: 'first hit', url: 'https://wiki/p1' },
            { id: 'p2', title: 'Other doc',   snippet: 'second hit', url: 'https://wiki/p2' },
          ],
        }));
        return;
      }
      // `/pages/p1` → page payload
      const m = req.url.match(/^\/pages\/([^/]+)/);
      if (m) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: m[1], title: `Page ${m[1]}`, url: `https://wiki/${m[1]}`,
          body: `Body of ${m[1]}.\nSecond line.`,
        }));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function main() {
  const { server: backend, baseUrl } = await startMockBackend();

  const child = spawn('node', [SERVER], {
    env: { ...process.env, WIKI_BASE_URL: baseUrl, WIKI_TOKEN: 'test-token' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  // Read NDJSON from child stdout into a queue. Each `next()` call returns
  // a promise that resolves to the next message.
  const queue = [];
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (waiters.length) waiters.shift()(msg);
        else queue.push(msg);
      } catch (e) {
        if (waiters.length) waiters.shift()(new Error(`bad json: ${line}`));
      }
    }
  });
  function next(timeoutMs = 5000) {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = waiters.indexOf(resolveOnce);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`timeout waiting for response after ${timeoutMs}ms`));
      }, timeoutMs);
      const resolveOnce = (v) => { clearTimeout(t); resolve(v); };
      waiters.push(resolveOnce);
    });
  }
  function send(msg) {
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  try {
    // 1. initialize
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const init = await next();
    try {
      assert.strictEqual(init.id, 1);
      assert.ok(init.result, 'expected result');
      assert.strictEqual(init.result.serverInfo.name, 'wiki');
      assert.ok(init.result.protocolVersion, 'protocolVersion present');
      assert.ok(init.result.capabilities?.tools, 'tools capability advertised');
      ok('initialize returns serverInfo + capabilities');
    } catch (e) { bad('initialize response', e.message); }

    // 2. notifications/initialized — no response expected
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // 3. tools/list
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await next();
    try {
      const names = (list.result?.tools || []).map(t => t.name).sort();
      assert.deepStrictEqual(names, ['fetch_page', 'search']);
      const search = list.result.tools.find(t => t.name === 'search');
      assert.ok(search.inputSchema.required.includes('query'), 'search requires query');
      ok('tools/list advertises search + fetch_page with proper input schema');
    } catch (e) { bad('tools/list', e.message); }

    // 4. tools/call search → mock backend returns 2 hits
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { query: 'hello' } } });
    const searchRes = await next();
    try {
      assert.ok(searchRes.result?.content, 'content present');
      const text = searchRes.result.content[0].text;
      assert.ok(text.includes('Hello world'), 'first hit title rendered');
      assert.ok(text.includes('Other doc'), 'second hit title rendered');
      assert.ok(text.includes('[p1]'), 'first hit id rendered');
      ok('tools/call search returns rendered result text');
    } catch (e) { bad('tools/call search', e.message); }

    // 5. tools/call fetch_page
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fetch_page', arguments: { id: 'p1' } } });
    const pageRes = await next();
    try {
      const text = pageRes.result.content[0].text;
      assert.ok(text.startsWith('# Page p1'), 'page title rendered as h1');
      assert.ok(text.includes('Body of p1.'), 'body included');
      ok('tools/call fetch_page returns page body');
    } catch (e) { bad('tools/call fetch_page', e.message); }

    // 6. error path — unknown tool name
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no-such-tool' } });
    const errRes = await next();
    try {
      assert.ok(errRes.error, 'error returned');
      assert.ok(/unknown tool/i.test(errRes.error.message), 'message names the unknown tool');
      ok('tools/call rejects unknown tool with error response');
    } catch (e) { bad('unknown tool error', e.message); }

    // 7. error path — fetch_page without id
    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'fetch_page', arguments: {} } });
    const errRes2 = await next();
    try {
      assert.ok(errRes2.error, 'error returned for missing id');
      ok('tools/call fetch_page validates required args');
    } catch (e) { bad('missing-id error', e.message); }

    // 8. unknown method
    send({ jsonrpc: '2.0', id: 7, method: 'wibble' });
    const errRes3 = await next();
    try {
      assert.strictEqual(errRes3.error.code, -32601, 'method-not-found code');
      ok('unknown method returns -32601 method-not-found');
    } catch (e) { bad('unknown method error', e.message); }

  } finally {
    child.stdin.end();
    child.kill();
    backend.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('test runner crashed:', err);
  process.exit(2);
});
