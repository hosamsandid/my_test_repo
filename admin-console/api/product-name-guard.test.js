'use strict';

// Product-name guard (#2855). "Admin Console" is the internal technical name of
// the web UI; users only ever meet the product name **Agent Studio**. This test
// fails when the prose form ("Admin Console", "admin console", "Admin-Konsole")
// reappears in a source whose text reaches a user — directly in the UI or help,
// or via an agent relaying a refusal, prompt line or CLI output verbatim.
//
// The lowercase path/identifier form `admin-console` (directory, service and
// container name) is deliberately allowed, and so are code comments: only the
// text a user can see counts.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');

const FORBIDDEN = /admin[\s-]?(?:console|konsole)/gi;
// The path/identifier form is not a product name.
const ALLOWED = 'admin-console';

const CODE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.py', '.sh', '']);
const COMMENT_PREFIXES = ['//', '/*', '*', '{/*', '<!--', '#'];

function walk(dir, accept, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, accept, out);
    else if (accept(p)) out.push(p);
  }
  return out;
}

const isTest = (p) => /(\.test\.[cm]?jsx?|^test_.*\.py)$/.test(path.basename(p));
const isCode = (p) => CODE_EXT.has(path.extname(p)) || p.endsWith('.html');
const isMd = (p) => p.endsWith('.md');

// Every user-reachable string source covered by the guard.
function userVisibleSources() {
  const files = [];
  const helper = path.join(REPO, 'admin-console', 'api', 'helper-chat');
  walk(path.join(helper, 'help-topics'), isMd, files);
  walk(path.join(helper, 'docs'), isMd, files);
  files.push(path.join(helper, 'system-prompt.md'));
  // UI strings and API error messages.
  walk(path.join(REPO, 'admin-console', 'src'), (p) => /\.(jsx?|mjs)$/.test(p) && !isTest(p), files);
  walk(path.join(REPO, 'admin-console', 'api'), (p) => p.endsWith('.js') && !isTest(p)
    && path.dirname(p) === path.join(REPO, 'admin-console', 'api'), files);
  // Orchestrator refusals / hints relayed into chat.
  walk(path.join(REPO, 'orchestrator'), (p) => p.endsWith('.js') && !isTest(p)
    && path.dirname(p) === path.join(REPO, 'orchestrator'), files);
  walk(path.join(REPO, 'orchestrator', 'skill-pool', 'skills'), isMd, files);
  // Plugin manifests (promptLine), brokers and plugin CLIs.
  for (const plugin of fs.readdirSync(path.join(REPO, 'plugins'), { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const dir = path.join(REPO, 'plugins', plugin.name);
    if (fs.existsSync(path.join(dir, 'plugin.json'))) files.push(path.join(dir, 'plugin.json'));
    walk(path.join(dir, 'broker'), (p) => isCode(p) && !isTest(p), files);
    walk(path.join(dir, 'bin'), (p) => !isTest(p), files);
  }
  // Agent system prompt and agent CLIs.
  files.push(path.join(REPO, 'agent-image', 'CLAUDE.md'));
  walk(path.join(REPO, 'agent-image', 'scripts'),
    (p) => /^(knowledge|aee-[\w-]+)$/.test(path.basename(p)), files);
  return files;
}

function offendingLines(file) {
  const code = !isMd(file) && !file.endsWith('.json');
  const hits = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (code && COMMENT_PREFIXES.some((c) => trimmed.startsWith(c))) return;
    for (const m of line.matchAll(FORBIDDEN)) {
      if (m[0] === ALLOWED) continue;
      hits.push(`${path.relative(REPO, file)}:${i + 1}: ${trimmed.slice(0, 160)}`);
    }
  });
  return hits;
}

test('the guard scans the known user-visible sources', () => {
  const rel = userVisibleSources().map((f) => path.relative(REPO, f));
  for (const expected of [
    'admin-console/api/helper-chat/help-topics/plugins.md',
    'admin-console/api/helper-chat/system-prompt.md',
    'orchestrator/plugin-run-identity.js',
    'plugins/jira/plugin.json',
    'plugins/jira/broker/server.js',
    'plugins/jira/bin/aee-jira.py',
    'agent-image/CLAUDE.md',
    'agent-image/scripts/knowledge',
  ]) {
    assert.ok(rel.includes(expected), `guard no longer scans ${expected}`);
  }
});

test('user-visible text says "Agent Studio", never "Admin Console" (#2855)', () => {
  const hits = userVisibleSources().flatMap(offendingLines);
  assert.deepEqual(hits, [], 'use the product name "Agent Studio" in user-visible text:\n' + hits.join('\n'));
});

test('the matcher flags the prose forms and allows the path form', () => {
  const flagged = (s) => [...s.matchAll(FORBIDDEN)].some((m) => m[0] !== ALLOWED);
  assert.ok(flagged('renew it in the Admin Console under Connections'));
  assert.ok(flagged('open the admin console'));
  assert.ok(flagged('in der Admin-Konsole'));
  assert.ok(flagged('Admin-Console'));
  assert.ok(!flagged('see admin-console/api/api.js'));
  assert.ok(!flagged('in Agent Studio under Connections → Plugin Tokens'));
});
