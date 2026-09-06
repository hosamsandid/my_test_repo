import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * agents-page-removal-guard.test.js — source-reading removal guard for #1930
 * (BP removal Phase 7 · Agent Chat merge Phase 3).
 *
 * The Agents page is gone. Every capability it carried was re-homed or retired
 * by an earlier ticket — the chat rail (#1928), the Settings tab (#1929), the
 * `/create` launcher and the page-action header (#1956), the rail's stub section
 * (#1957), the add-member dialog (#1958), the missing-role suggestion (#1959,
 * removed), the orphan block (#1960, removed) and the whole Orchestrator /
 * BriefingPack half (#1961). What is left to guard is that the *deletion* stays
 * a deletion: a page nobody can reach is easy to revive one import at a time,
 * and a route that dead-ends is easy to create by removing the redirect with the
 * page.
 *
 * Almost all of it lives in JSX that `node --test` cannot render (#651), so it
 * is only assertable as absence from — and survival in — the source.
 *
 * The four properties it locks:
 *   AC1  the page, its view module and every import of them are gone;
 *   AC2  `/agents` and the `/blueprints` alias that used to land there still
 *        RESOLVE — as redirects to `/chats` — so no bookmark dead-ends;
 *   AC3  the breadcrumb / route-title pair and the sidebar entry are gone
 *        together, so no route resolves to a stale "Agents" title;
 *   AC4  nothing in the console links to `/agents` any more.
 *
 * **Comments are stripped before every "this is gone" assertion**, because a
 * removal PR's own explanatory comments name the removed thing on purpose —
 * App.jsx's redirect comment and Shell.jsx's nav comment both do. The strip is
 * line-oriented for `//` (a URL's `//` is always preceded by `:`), and it is
 * itself checked below: an absence assertion over an over-stripped source is
 * vacuously green. Each absence is paired with a POSITIVE assertion over the
 * same file, so a renamed or emptied file cannot pass by disappearing.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..');

const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8');

/** Block comments, then whole-line `//` comments. Never a mid-line `//`. */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const app = strip(read('App.jsx'));
const shell = strip(read('components/Shell.jsx'));
const breadcrumbs = strip(read('components/breadcrumbs.js'));
const routeTitle = strip(read('route-title.js'));

/* ── AC1: the page and its view module are gone ──────────────────────── */

test('the page and the pure view module that served only it are deleted', () => {
  for (const gone of ['Agents.jsx', 'agents-view.js', 'agents-view.test.js']) {
    assert.equal(
      existsSync(path.join(HERE, gone)), false,
      `pages/${gone} should be deleted — it had no consumer left`,
    );
  }
  // Survival: the modules the page's capabilities moved INTO are still there.
  // Without this, the block above would also pass on an emptied pages/ tree.
  for (const kept of [
    'AgentChat.jsx', 'Create.jsx',
    'agent-lifecycle/AgentEditForm.jsx', 'agent-lifecycle/AgentCreateForm.jsx',
    'agent-chat/AgentSettingsPanel.jsx', 'agent-chat/RailLifecycleHost.jsx',
  ]) {
    assert.ok(existsSync(path.join(HERE, kept)), `pages/${kept} must survive the removal`);
  }
});

test('App.jsx neither imports nor renders the page', () => {
  assert.doesNotMatch(app, /import\(['"]\.\/pages\/Agents['"]\)/, 'the lazy import must be gone');
  assert.doesNotMatch(app, /<Agents\s*\/>/, 'the route element must be gone');
  assert.doesNotMatch(app, /\bconst Agents\b/, 'no binding for the page may remain');
  // Survival: the sibling lazy imports are untouched, so the assertions above
  // are not passing because the import block itself was gutted.
  assert.match(app, /const AgentChat\s+= lazy\(\(\) => import\('\.\/pages\/AgentChat'\)\)/);
});

/* ── AC2: no dead end ────────────────────────────────────────────────── */

test('/agents and the /blueprints alias both redirect instead of dead-ending', () => {
  // `/blueprints` pointed AT `/agents`, so removing the page without re-pointing
  // it would have turned one dead end into two.
  for (const from of ['/agents', '/blueprints']) {
    assert.match(
      app,
      new RegExp(`<Route path="${from}"\\s+element=\\{<Navigate to="/chats" replace />\\}`),
      `${from} must resolve to a redirect, not to nothing`,
    );
  }
  assert.match(app, /<Route path="\/chats"\s+element=\{<AgentChat \/>\}/, 'the target must exist');
});

/* ── AC3: nav, breadcrumb and route title leave together ─────────────── */

test('the sidebar entry is gone and the Agent Setup group still reads sensibly', () => {
  assert.doesNotMatch(shell, /path: '\/agents'/, 'the nav item must be gone');
  assert.doesNotMatch(shell, /\bLayers\b/, 'its icon import goes with it (no unused import)');
  // Survival: the group and the rest of its items are intact, and Agent Chat —
  // which took the page's job — is still the entry above the groups.
  assert.match(shell, /section: 'Agent Setup'/);
  for (const kept of ['/flows', '/role-templates', '/skills', '/knowledge']) {
    assert.match(shell, new RegExp(`path: '${kept}'`), `${kept} must stay in the group`);
  }
  assert.match(shell, /path: '\/chats',\s+label: 'Agent Chat'/);
});

test('the breadcrumb and route-title pair drop /agents together', () => {
  // The team convention is that these two change together; a route left in one
  // of them resolves to a stale "Agents" title or breadcrumb.
  assert.doesNotMatch(breadcrumbs, /'\/agents'/, 'BREADCRUMBS must not know the route');
  assert.doesNotMatch(routeTitle, /'\/agents'/, 'ROUTE_TITLES must not know the route');
  // Survival: both maps are still populated and still agree on Agent Chat.
  assert.match(breadcrumbs, /'\/chats':\s+'Agent Chat'/);
  assert.match(routeTitle, /'\/chats': 'Agent Chat'/);
});

/* ── AC4: nothing links to the route any more ────────────────────────── */

// The only two files that may still NAME the route, because their whole job is
// to say where it now goes. Both are asserted positively below, so neither can
// use the exemption to keep a link the ticket removed.
const TOPOLOGY = new Set(['App.jsx', 'context/page-help-view.js']);

// Every source file under src/, minus the tests (a test may legitimately use
// `/agents` as an arbitrary fixture pathname) and minus this guard.
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...sources(full)); continue; }
    if (!/\.(js|jsx)$/.test(name) || /\.test\.js$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

test('no console source links to, or navigates to, /agents', () => {
  const files = sources(SRC);
  // Survival: the walk really found the tree. An empty file list would make the
  // loop below pass without reading a thing.
  assert.ok(files.length > 100, `expected the whole src tree, walked ${files.length} files`);

  const offenders = [];
  for (const full of files) {
    const rel = path.relative(SRC, full).split(path.sep).join('/');
    if (TOPOLOGY.has(rel)) continue;
    // `/api/agents` (the REST collection) and `/workspace/agents` (the pool
    // path) are unrelated to the route and must not be caught.
    const src = strip(readFileSync(full, 'utf8'))
      .replace(/\/api\/matrix\/agents/g, '')
      .replace(/\/api\/agents/g, '')
      .replace(/\/workspace\/agents/g, '');
    if (/\/agents\b/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'these still reference the removed route');
});

test('the two exempt topology files name the route only to redirect it', () => {
  // The exemption is not a hole: each file's `/agents` occurrences are pinned to
  // the redirect that keeps AC2's "no dead end" promise.
  const helpView = strip(read('context/page-help-view.js'));
  assert.match(helpView, /'\/agents': '\/chats'/, 'the client help mirror redirects it');
  assert.match(app, /<Route path="\/agents"\s+element=\{<Navigate to="\/chats" replace \/>\}/);
  // …and neither carries a LINK to it, which is what AC4 is actually about.
  for (const [name, src] of [['App.jsx', app], ['page-help-view.js', helpView]]) {
    assert.doesNotMatch(src, /to="\/agents"/, `${name} must render no link to the route`);
    assert.doesNotMatch(src, /navigate\('\/agents'\)/, `${name} must not navigate to it`);
  }
});

/* ── the strip itself ────────────────────────────────────────────────── */

test('strip removes comments and leaves real code standing', () => {
  const sample = [
    '// the /agents page is gone',
    '/* and /agents is gone from here too */',
    "const url = 'https://example.com/agents';",
    "const keep = '/agents';",
  ].join('\n');
  const out = strip(sample);
  assert.doesNotMatch(out, /the \/agents page is gone/, 'a line comment must be stripped');
  assert.doesNotMatch(out, /gone from here too/, 'a block comment must be stripped');
  // The two lines that matter: a mid-line `//` inside a URL survives, and a real
  // code occurrence survives — otherwise every absence assertion above would be
  // green because the strip ate the evidence.
  assert.match(out, /https:\/\/example\.com\/agents/);
  assert.match(out, /const keep = '\/agents';/);
});

test('the absence assertions are not vacuous: the real sources are non-empty', () => {
  for (const [name, src] of [
    ['App.jsx', app], ['Shell.jsx', shell],
    ['breadcrumbs.js', breadcrumbs], ['route-title.js', routeTitle],
  ]) {
    assert.ok(src.length > 500, `${name} stripped down to ${src.length} chars — strip is too greedy`);
  }
});
