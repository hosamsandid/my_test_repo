'use strict';

// Source-reading drift guard for revoking a grant whose plugin is uninstalled
// (#2651, #651 convention). The decisions are pure and covered in
// plugin-grants.test.js (uninstalledRevokeGrant) and plugin-sync.test.js
// (withStoredCliNames); `orchestrator.js` boots listeners on require, so this
// file checks that the seams still CALL them.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function slice(src, startAnchor, endAnchor, maxSpan) {
  const a = src.indexOf(startAnchor);
  assert.notEqual(a, -1, `start anchor not found: ${startAnchor}`);
  const b = src.indexOf(endAnchor, a + startAnchor.length);
  assert.notEqual(b, -1, `end anchor not found after start: ${endAnchor}`);
  assert.ok(b - a <= maxSpan, `slice ${startAnchor} → ${endAnchor} is ${b - a} chars, expected ≤ ${maxSpan}`);
  return src.slice(a, b);
}

test('_resolvePluginGrant falls back to a held grant before the not-installed error', () => {
  const body = slice(SRC, '_resolvePluginGrant(pluginId, scopeGranularity, {', 'const granularity = scopeGranularity || defaultGranularity(entry.manifest);', 900);
  assert.match(body, /if \(!entry\.ok\) \{\s*const orphan = uninstalledRevokeGrant\(active, currentGrant, id\);\s*if \(orphan\) return \{ manifest: null, granularity: orphan\.scopeGranularity \};\s*throw new Error/);
});

test('the team route passes the direction and the team\'s own grant list', () => {
  const body = slice(SRC, 'async setTeamPluginActive(teamId, pluginId,', 'const before = ', 700);
  assert.match(body, /this\._resolvePluginGrant\(pluginId, scopeGranularity, \{\s*active, currentGrant: normalizeGrantList\(teamCfg\.plugins\),\s*\}\)/);
});

test('the agent route passes the direction and the agent\'s effective grant', () => {
  const body = slice(SRC, 'async setAgentPluginActive(id, pluginId,', 'const prev = effectivePlugins(cfg, loadAgentConfig);', 700);
  assert.match(body, /this\._resolvePluginGrant\(pluginId, scopeGranularity, \{\s*active, currentGrant: effectivePlugins\(cfg, loadAgentConfig\),\s*\}\)/);
});

test('the workspace sync names an uninstalled plugin\'s CLI from its seeded config', () => {
  const body = slice(SRC, 'async _syncPluginIntoWorkspace(id, cfg, prevGrant, nextGrant) {', 'const written = [];', 1600);
  assert.match(body, /path\.join\(dir, PLUGINS_DIR, `\$\{pluginId\}\.json`\)/);
  assert.match(body, /prevGrant: withStoredCliNames\(prevGrant, manifests, readStoredConfig\),/);
  // The legacy-dir migration must run before the stored config is read.
  assert.ok(body.indexOf('resolveAgentStateDir(dir);') < body.indexOf('const plan = planWorkspaceSync({'));
});
