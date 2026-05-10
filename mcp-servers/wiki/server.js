#!/usr/bin/env node
'use strict';

/*
 * Reference MCP server: Wiki search + page fetch over a configurable REST
 * backend. Speaks the MCP stdio transport (newline-delimited JSON-RPC 2.0)
 * with no third-party dependencies, so it ships as a single file baked into
 * the orchestrator image.
 *
 * Backend assumptions (Confluence/Notion-shaped):
 *   GET <WIKI_BASE_URL>/search?q=<query>                  → { results: [{ id, title, snippet, url }, ...] }
 *   GET <WIKI_BASE_URL>/pages/<id>                        → { id, title, url, body }
 *
 * Auth: Bearer <WIKI_TOKEN> (omitted if WIKI_TOKEN is empty).
 *
 * Override <WIKI_SEARCH_PATH> / <WIKI_PAGE_PATH> if the backend uses
 * different routes; both default to the shapes above.
 */

const readline = require('readline');

const BASE_URL    = (process.env.WIKI_BASE_URL    || '').replace(/\/+$/, '');
const TOKEN       = process.env.WIKI_TOKEN        || '';
const SEARCH_PATH = process.env.WIKI_SEARCH_PATH  || '/search';
const PAGE_PATH   = process.env.WIKI_PAGE_PATH    || '/pages/{id}';
const SERVER_NAME = 'wiki';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'search',
    description: 'Search the wiki for pages matching a query. Returns up to 20 hits with id, title, snippet, and URL.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query (full-text search)' },
        limit: { type: 'integer', description: 'Max hits to return (1–50, default 20)', minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description: 'Fetch the full text of a single wiki page by id. Use the `id` returned by `search`.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Page id' },
      },
      required: ['id'],
    },
  },
];

function buildHeaders() {
  const h = { 'Accept': 'application/json' };
  if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
  return h;
}

async function httpJson(url) {
  if (!BASE_URL) throw new Error('WIKI_BASE_URL is not configured');
  const res = await fetch(url, { headers: buildHeaders() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Backend ${res.status}: ${text.slice(0, 500)}`);
  }
  try { return JSON.parse(text); } catch { throw new Error(`Backend returned non-JSON: ${text.slice(0, 200)}`); }
}

async function toolSearch({ query, limit }) {
  if (!query || typeof query !== 'string') throw new Error('query is required');
  const cap = Math.min(50, Math.max(1, Number.isInteger(limit) ? limit : 20));
  const u = new URL(BASE_URL + SEARCH_PATH);
  u.searchParams.set('q', query);
  u.searchParams.set('limit', String(cap));
  const data = await httpJson(u.toString());
  const results = Array.isArray(data?.results) ? data.results.slice(0, cap) : [];
  const lines = results.length === 0
    ? ['No results.']
    : results.map((r, i) => {
        const title = r.title || '(untitled)';
        const snippet = (r.snippet || '').replace(/\s+/g, ' ').trim();
        const url = r.url || '';
        return `${i + 1}. [${r.id}] ${title}${url ? ` — ${url}` : ''}${snippet ? `\n    ${snippet}` : ''}`;
      });
  return lines.join('\n');
}

async function toolFetchPage({ id }) {
  if (!id || typeof id !== 'string') throw new Error('id is required');
  const url = BASE_URL + PAGE_PATH.replace('{id}', encodeURIComponent(id));
  const page = await httpJson(url);
  const title = page?.title || '(untitled)';
  const body  = page?.body  || '';
  const link  = page?.url   || '';
  return `# ${title}\n${link ? `Source: ${link}\n` : ''}\n${body}`;
}

async function dispatchTool(name, args) {
  if (name === 'search') return toolSearch(args || {});
  if (name === 'fetch_page') return toolFetchPage(args || {});
  throw new Error(`unknown tool: ${name}`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req) {
  const id = req.id;
  const isNotification = id === undefined || id === null;
  try {
    let result;
    switch (req.method) {
      case 'initialize':
        result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
        break;
      case 'initialized':
      case 'notifications/initialized':
        return; // notification, no response
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const text = await dispatchTool(req.params?.name, req.params?.arguments);
        result = { content: [{ type: 'text', text }] };
        break;
      }
      case 'ping':
        result = {};
        break;
      default:
        if (isNotification) return;
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } });
        return;
    }
    if (!isNotification) send({ jsonrpc: '2.0', id, result });
  } catch (err) {
    if (!isNotification) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message || String(err) } });
    } else {
      process.stderr.write(`[wiki-mcp] notification error: ${err.message || err}\n`);
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); }
  catch (e) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  // Batched messages allowed by JSON-RPC 2.0 — handle each independently.
  if (Array.isArray(msg)) {
    for (const m of msg) handle(m);
  } else {
    handle(msg);
  }
});
rl.on('close', () => process.exit(0));
