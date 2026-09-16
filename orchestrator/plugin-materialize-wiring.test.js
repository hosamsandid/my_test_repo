'use strict';

// Source-reading drift guard for plugin materialisation (#2308, #651).
//
// The bug was never in the pure planners (`plugin-grants.js`/`plugin-sync.js`
// are exercised by `plugin-grants.test.js`/`plugin-sync.test.js`/
// `plugin-wiring.test.js`) — it was that NOTHING called them from the three
// creation paths. `orchestrator.js` boots two HTTP listeners on require, so it
// cannot be imported here; these checks instead prove the SEAMS exist and
// cannot silently regress, the same convention as
// `offboarding-reconcile-wiring.test.js` / `baseline-github-token-wiring.test.js`.
//
// Written as a dict of NAMED predicates, each proven non-vacuous by a mutation
// that makes exactly it fire.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

// A bounded slice between two anchors. `maxSpan` guards against an end anchor
// that matches far past the intended block, which would silently swallow
// unrelated code and turn an "X is not in here" assertion into a vacuous pass.
function slice(src, startAnchor, endAnchor, maxSpan) {
  const a = src.indexOf(startAnchor);
  assert.notEqual(a, -1, `start anchor not found: ${startAnchor}`);
  const b = src.indexOf(endAnchor, a + startAnchor.length);
  assert.notEqual(b, -1, `end anchor not found after start: ${endAnchor}`);
  const span = b - a;
  assert.ok(span <= maxSpan, `slice ${startAnchor} → ${endAnchor} is ${span} chars, expected ≤ ${maxSpan}`);
  return src.slice(a, b);
}

// ── the named checks ────────────────────────────────────────────────────────

const CHECKS = {
  // AC1/AC2. Before #2308 no creation path ever called anything plugin-shaped
  // here — a fresh member's grant resolved correctly but its workspace was
  // never touched. This is the seam that closes it.
  'add-team-member-materialises-plugins-before-start'(src) {
    const body = slice(src, 'this.agentConfigs.set(memberId, { config: memberConfig });', 'if (memberConfig.enabled !== false) startAgentProcess(memberConfig);', 1500);
    return /const pluginSync = await this\._materializeMemberPlugins\(memberId, memberConfig\);/.test(body);
  },

  // AC5. `enableAgent`'s stub→live branch mirrors `skills: effectiveSkills(...)`
  // — before #2308 it had no plugin equivalent at all.
  'enable-agent-materialises-plugins-before-start'(src) {
    const body = slice(src, 'console.log(`[Orchestrator] Materialized team-member', 'startAgentProcess(updated);', 700);
    return /const pluginSync = await this\._materializeMemberPlugins\(id, updated\);/.test(body);
  },

  // AC18. A response that silently dropped the sync outcome would leave the
  // add "succeeding" with no trace of what failed.
  'both-materialize-paths-merge-plugin-warnings-into-the-response'(src) {
    const addBody = slice(src, 'const pluginSync = await this._materializeMemberPlugins(memberId, memberConfig);', 'clones: seedResult.clones || [],', 1700);
    const enableBody = slice(src, 'const pluginSync = await this._materializeMemberPlugins(id, updated);', 'clones: seedResult.clones || [],', 700);
    const mergesWarnings = /warnings: \[\.\.\.\(seedResult\.warnings \|\| \[\]\), \.\.\.pluginSync\.warnings\]/;
    return mergesWarnings.test(addBody) && mergesWarnings.test(enableBody);
  },

  // AC7. Nothing granted → nothing to do. Without this an ungranted member
  // would take the sync path for no reason (harmless but wasteful, and it
  // would defeat the "nothing granted, nothing recorded" contract elsewhere).
  '_materializeMemberPlugins-is-a-no-op-with-no-grant'(src) {
    const body = slice(src, 'async _materializeMemberPlugins(id, cfg) {', '\n  }\n', 1800);
    return /if \(!Array\.isArray\(next\) \|\| next\.length === 0\) return \{ warnings: \[\] \};/.test(body);
  },

  // AC17, the load-bearing guarantee: a plugin that cannot be installed must
  // degrade the member, never fail the add/enable. Both the expected-error
  // path (`result.errors`) and the unexpected-throw path are covered — a
  // caller of `_materializeMemberPlugins` never sees a rejection.
  '_materializeMemberPlugins-never-throws'(src) {
    const body = slice(src, 'async _materializeMemberPlugins(id, cfg) {', '\n  }\n', 1800);
    return /try \{\s*\n\s*const result = await this\._syncPluginIntoWorkspace\(id, cfg, \[\], next\);/.test(body)
      && /\} catch \(err\) \{\s*\n\s*\/\/ Should not happen/.test(body)
      && !/throw /.test(body);
  },

  // AC18/AC19. A failure must be human-readable (names the plugin) AND land
  // on the operator-facing timeline, not just a response field nobody reads
  // later.
  '_materializeMemberPlugins-records-every-failure-for-later-discovery'(src) {
    const body = slice(src, 'async _materializeMemberPlugins(id, cfg) {', '\n  }\n', 1800);
    const inlineError = /warnings\.push\(`plugin '\$\{pluginId\}' could not be installed for '\$\{id\}': \$\{e\.error\}`\);\s*\n\s*recordPluginSyncFailure\(id, pluginId, e\.error\);/;
    const thrownError = /for \(const g of next\) recordPluginSyncFailure\(id, g\.id, err\.message\);/;
    return inlineError.test(body) && thrownError.test(body);
  },

  // AC12. A partial per-plugin write failure (e.g. the CLI copies but the
  // token config write then throws) must not strand a bin with no config —
  // both are rolled back and neither is recorded as synced.
  '_syncPluginIntoWorkspace-rolls-back-a-partial-per-plugin-write'(src) {
    const body = slice(src, 'const writesByPlugin = new Map();', 'for (const rel of plan.remove) {', 2200);
    return /for \(const p of okPaths\) \{ try \{ fs\.rmSync\(path\.join\(dir, p\), \{ force: true \}\); \} catch/.test(body)
      && /failedPluginIds\.add\(pluginId\);/.test(body)
      && !/written\.push\(\.\.\.okPaths\);\s*\n\s*if \(failure\)/.test(body); // written is only pushed in the non-failure branch
  },

  // #2308's own diagnosis (point 4): the boot/toggle reconcile re-attached a
  // plugin's sidecar network from the GRANT alone, so a member whose sync
  // failed (or never ran) ended up "networked yet CLI-less". Gating on the
  // seeded-plugins manifest closes that.
  'network-reconcile-requires-the-seeded-plugins-manifest-not-just-the-grant'(src) {
    const body = slice(src, 'async _reconcilePluginNetworks(pluginIds) {', 'results.push({ pluginId, ...(await pluginRuntime.reconcilePluginAttachments(pluginId, granted)) });', 1000);
    return /\.filter\(\(c\) => !!readSeededPlugins\(c\.id\)\[pluginId\]\)/.test(body);
  },

  // #2308's own diagnosis (edge case): "no seeded-plugin manifest exists...
  // a back-fill has to determine 'already synced' some other way". This is
  // that manifest, kept in lockstep with what was ACTUALLY written, not with
  // the grant.
  'seeded-plugins-manifest-is-updated-from-actual-writes-not-the-grant'(src) {
    const body = slice(src, 'const seeded = readSeededPlugins(id);', 'writeSeededPlugins(id, seeded);', 900);
    return /if \(!g \|\| !g\.id \|\| failedPluginIds\.has\(g\.id\)\) continue;/.test(body)
      && /seeded\[g\.id\] = \{ scopeGranularity: g\.scopeGranularity, seededAt: new Date\(\)\.toISOString\(\) \};/.test(body);
  },

  // D2/AC10/AC11: the boot-time auto-reconcile that heals an already-broken
  // member without the deactivate/reactivate dance the issue reported.
  'boot-registers-the-plugin-reconcile-timer'(src) {
    const body = slice(src, 'const runPluginReconcile = async () => {', 'if (typeof pluginReconcileTimer.unref === "function") pluginReconcileTimer.unref();', 700);
    return /await orchestrator\.reconcilePendingPlugins\(\);/.test(body)
      && /const pluginReconcileTimer = setInterval\(runPluginReconcile, PLUGIN_RECONCILE_INTERVAL_MS\);/.test(body);
  },

  // AC16: the comment that used to claim "the normal seed path applies it at
  // enable" — false until this ticket — must no longer read as a standing
  // fact with no seam behind it.
  'stub-branch-comment-no-longer-claims-a-seed-path-that-does-not-exist'(src) {
    // Anchored on `setTeamPluginActive`'s own signature (unique) rather than on
    // `if (step.action === "stub")`, which `setTeamSkillActive` shares verbatim
    // — an ambiguous anchor would silently grade the SKILL branch instead.
    const body = slice(src, 'async setTeamPluginActive(teamId, pluginId,', 'results.push({ agentId: step.agentId, status: "stub" });', 3000);
    return /enableAgent\(\) materialises the resolved/.test(body)
      && !/the normal seed path applies it at enable/.test(body);
  },
};

function runCheck(src) {
  for (const [name, fn] of Object.entries(CHECKS)) {
    let ok = false;
    try {
      ok = fn(src);
    } catch {
      return name; // a slice that no longer resolves IS the drift
    }
    if (!ok) return name;
  }
  return null;
}

test('#2308: plugin materialisation is wired into orchestrator.js', () => {
  assert.equal(runCheck(SRC), null);
});

// Each mutation must make EXACTLY the named check fire.
const MUTATIONS = [
  ['add-team-member-materialises-plugins-before-start',
    'const pluginSync = await this._materializeMemberPlugins(memberId, memberConfig);',
    'const pluginSync = { warnings: [] };'],
  ['enable-agent-materialises-plugins-before-start',
    'const pluginSync = await this._materializeMemberPlugins(id, updated);',
    'const pluginSync = { warnings: [] };'],
  ['both-materialize-paths-merge-plugin-warnings-into-the-response',
    'warnings: [...(seedResult.warnings || []), ...pluginSync.warnings],\n      clones: seedResult.clones || [],\n    };\n  }\n\n  // ===========================================================',
    'warnings: seedResult.warnings || [],\n      clones: seedResult.clones || [],\n    };\n  }\n\n  // ==========================================================='],
  ['_materializeMemberPlugins-is-a-no-op-with-no-grant',
    'if (!Array.isArray(next) || next.length === 0) return { warnings: [] }; // AC7: nothing granted, nothing to do',
    'if (false) return { warnings: [] };'],
  ['_materializeMemberPlugins-never-throws',
    '    } catch (err) {\n      // Should not happen (_syncPluginIntoWorkspace is itself best-effort), but',
    '    } catch (err) {\n      throw err; // Should not happen (_syncPluginIntoWorkspace is itself best-effort), but'],
  ['_materializeMemberPlugins-records-every-failure-for-later-discovery',
    'for (const g of next) recordPluginSyncFailure(id, g.id, err.message);',
    'void next;'],
  ['_syncPluginIntoWorkspace-rolls-back-a-partial-per-plugin-write',
    'for (const p of okPaths) { try { fs.rmSync(path.join(dir, p), { force: true }); } catch { /* best effort */ } }',
    'void okPaths;'],
  ['network-reconcile-requires-the-seeded-plugins-manifest-not-just-the-grant',
    '        .filter((c) => !!readSeededPlugins(c.id)[pluginId])\n        .map((c) => c.id);',
    '        .map((c) => c.id);'],
  ['seeded-plugins-manifest-is-updated-from-actual-writes-not-the-grant',
    'seeded[g.id] = { scopeGranularity: g.scopeGranularity, seededAt: new Date().toISOString() };',
    'void g;'],
  ['boot-registers-the-plugin-reconcile-timer',
    'const pluginReconcileTimer = setInterval(runPluginReconcile, PLUGIN_RECONCILE_INTERVAL_MS);',
    'void runPluginReconcile;'],
  ['stub-branch-comment-no-longer-claims-a-seed-path-that-does-not-exist',
    'enableAgent() materialises the resolved',
    'the normal seed path applies it at enable'],
];

test('#2308: every wiring check is proven by a mutation that makes exactly it fire', () => {
  const fired = new Set();
  for (const [expected, find, replace] of MUTATIONS) {
    const hits = SRC.split(find).length - 1;
    assert.equal(hits, 1, `mutation anchor for ${expected} matches ${hits}x (must be exactly 1): ${find.slice(0, 70)}`);
    const mutated = SRC.replace(find, replace);
    assert.notEqual(mutated, SRC, `mutation for ${expected} did not change the source`);
    assert.equal(runCheck(mutated), expected, `mutation for ${expected} fired the wrong check`);
    fired.add(expected);
  }
  assert.deepEqual([...Object.keys(CHECKS)].filter((k) => !fired.has(k)), []);
});
