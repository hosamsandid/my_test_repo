'use strict';

// Source-reading drift guard for the offboarding safety net (#2138, #651).
//
// Every judgement is unit-tested in `credential-resolution.test.js` and every
// route behaviour in `teams-admin-route.test.js`. What neither can test is that
// `orchestrator.js` actually CALLS them — it boots two HTTP listeners on
// require, so it cannot be imported here.
//
// The properties below are the ones whose loss would be SILENT, which is the
// whole subject of this ticket: offboarding was dead for four weeks and every
// caller saw a clean deletion. A live-user gate that is never threaded into the
// resolver, a boot sweep that is registered but never awaited into a rejection
// handler, or a sweep that acts on an unknown user list all pass every unit
// test in the tree while doing the wrong thing on a real stack.
//
// Written as a dict of NAMED predicates so each one is proven non-vacuous by a
// mutation that makes exactly it fire (the `admission-control-wiring.test.js`
// arrangement).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

// A bounded slice between two anchors. `maxSpan` is not decoration: an end
// anchor matching far past the intended block silently swallows unrelated code
// and turns an "X is not in here" assertion into a vacuous pass.
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
  // AC6. The gate must reach the resolver, or the pure orphan check is dead
  // code and a departed human's PAT keeps signing pushes exactly as before.
  'attributed-write-consults-the-live-user-gate'(src) {
    const body = slice(src, 'function resolveAttributedGithubToken(id, env, operation)', '  return { githubTokenId:', 1400);
    return /findPersonalCredentialState\(\s*loadGithubTokenIndex\(\), ownerId, undefined, loadLiveUserGate\(\)\)/.test(body)
      && /personalCredentialOrphaned: personal\.orphaned,/.test(body);
  },

  // Fail OPEN on an unreadable user index: `buildLiveUserGate(null)` answers
  // `known: false`, which every consumer treats as pre-#2138 behaviour. Letting
  // the throw escape would take every attributed write on the stack offline.
  //
  // Ordered BEFORE the no-cache check below, which reads the same slice: both
  // fire on a missing fallback return, and the more specific one must win or
  // the harness reports "fired the wrong check".
  'unreadable-user-index-degrades-to-an-unknown-gate'(src) {
    const body = slice(src, 'function loadLiveUserGate()', '\n}\n', 700);
    return /catch \(err\) \{/.test(body) && /return credentialResolution\.buildLiveUserGate\(null\);/.test(body);
  },

  // The gate is rebuilt per call. A cached one would reintroduce exactly the
  // window this closes: a credential must stop resolving the moment its owner
  // is deleted, not at the next orchestrator restart. Asserted as "both return
  // paths construct one directly" rather than by grepping for a memo keyword —
  // there are many spellings of a cache and only two of a fresh build.
  'live-user-gate-is-not-cached'(src) {
    const body = slice(src, 'function loadLiveUserGate()', '\n}\n', 700);
    const returns = body.match(/return [^;]+;/g) || [];
    return returns.length === 2
      && returns[0] === 'return credentialResolution.buildLiveUserGate(teamsStore.listUsers());'
      && returns[1] === 'return credentialResolution.buildLiveUserGate(null);';
  },

  // AC2, and the dangerous direction. With nobody KNOWN to be live, every owner
  // looks deleted — a sweep run on that belief drains the whole installation.
  'sweep-refuses-when-the-live-user-set-is-unknown'(src) {
    const body = slice(src, 'async reconcileOrphanedOffboardings({ dryRun = false } = {})', 'const sshKeys = loadSshKeyIndex();', 900);
    const guard = body.indexOf("if (!liveUsers.known)");
    const ret = body.indexOf("reason: 'live-users-unknown'");
    return guard !== -1 && ret !== -1 && guard < ret;
  },

  // AC2 asks for the existing `offboardOwner` path to be replayed rather than a
  // bespoke cleanup, so the remediation exercises the thing being fixed.
  'sweep-drives-offboardOwner-not-a-bespoke-cleanup'(src) {
    const body = slice(src, 'const paused = [];\n    for (const ownerId of owners) {', 'return { ran: true, reason: null, owners, credentials, paused };', 700);
    return /await this\.offboardOwner\(ownerId\)/.test(body)
      && !/_deletePersonalCredentials\(/.test(body)
      && !/disableAgent\(/.test(body);
  },

  // AC1/AC3. The assessment is logged BEFORE anything is deleted, and it names
  // the fingerprint — deleting the local copy is not revocation, and once the
  // index entry is gone the operator has nothing left to revoke at GitHub with.
  'assessment-is-logged-before-the-cleanup-acts'(src) {
    const body = slice(src, 'const orphanSet = new Set(owners);', 'const paused = [];', 2600);
    const report = body.indexOf('REVOKE IT AT GITHUB');
    const dry = body.indexOf("if (dryRun) return");
    return report !== -1 && dry !== -1 && report < dry && /fingerprint \$\{c\.fingerprint/.test(body);
  },

  // AC2. Registered at boot, after init() so `agentConfigs` is populated, and
  // non-blocking with its own rejection handler — a stack must still boot.
  'boot-registers-the-sweep-after-init-and-never-blocks'(src) {
    const body = slice(src, 'await orchestrator.init();', 'const internalApi = http.createServer', 3000);
    return /orchestrator\.reconcileOrphanedOffboardings\(\)\s*\n\s*\.catch\(/.test(body)
      && !/await orchestrator\.reconcileOrphanedOffboardings\(/.test(body);
  },

  // AC5. `offboarding` must never be a bare `null` again — that is precisely
  // what made a total failure indistinguishable from a clean deletion.
  'delete-route-never-reports-a-null-offboarding'(src) {
    // Anchored on the users branch's own comment: `handleTeamsAdminApi` has TWO
    // `DELETE && resourceId` branches (teams and users) and indexOf finds the
    // teams one, which would slice past this code entirely and pass vacuously.
    const body = slice(src, '// The D4 last-admin refusal (#2081 AC5) is re-checked HERE', 'const deleted = teamsStore.deleteUser(resourceId);', 5000);
    return /let offboarding;/.test(body)
      && !/let offboarding = null;/.test(body)
      && /ok: true, \.\.\.\(await orchestratorSingleton\.offboardOwner\(resourceId\)\)/.test(body)
      && /ok: false, ownerId: resourceId/.test(body);
  },

  // AC5. A degradation reaches the operator-visible timeline, not only a
  // console line nobody reads — including the PARTIAL case, where nothing threw
  // but an agent of the departed human could not be paused.
  'degradation-is-recorded-including-the-partial-case'(src) {
    const body = slice(src, "if (!offboarding.ok || (offboarding.skipped || []).length) {", 'const deleted = teamsStore.deleteUser(resourceId);', 1800);
    return /recordOffboardingDegradation\(resourceId, detail\);/.test(body);
  },

  // Q1's answer, pinned: the deletion COMPLETES. Refusing it would leave a
  // present user whose credentials are also still present and whose offboarding
  // the operator cannot finish by any other route.
  'a-degraded-offboarding-does-not-abort-the-deletion'(src) {
    const body = slice(src, "if (!offboarding.ok || (offboarding.skipped || []).length) {", 'const deleted = teamsStore.deleteUser(resourceId);', 1800);
    return !/return sendJson\(/.test(body) && !/throw /.test(body);
  },

  // The event-log write must never break a deletion. `record` swallows its own
  // I/O errors; this wrapper covers entry construction.
  'event-log-write-cannot-fail-a-deletion'(src) {
    const body = slice(src, 'function recordOffboardingDegradation(userId, detail)', '\n}\n', 1400);
    return /try \{/.test(body) && /\} catch \(err\) \{/.test(body) && /githubEventLog\.record\(\{/.test(body);
  },

  // The console's `/api/github-events` reader resolves an agent name per
  // outcome via `path.join(AGENTS_DIR, o.agentId, …)`, which THROWS on a null
  // agentId — one such row would 500 the whole Event Log page. We do not know
  // which agents failed to pause (that is the failure being reported), so the
  // list stays empty rather than carrying a null-id entry.
  'degradation-event-carries-no-null-agent-outcome'(src) {
    const body = slice(src, 'function recordOffboardingDegradation(userId, detail)', '\n}\n', 1400);
    return /outcomes: \[\],/.test(body) && !/agentId: null/.test(body);
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

test('#2138: the offboarding safety net is wired into orchestrator.js', () => {
  assert.equal(runCheck(SRC), null);
});

// Each mutation must make EXACTLY the named check fire. Ordering matters in
// `CHECKS`: two checks reading the same slice mean one mutation trips both and
// the harness reports "fired the wrong check".
const MUTATIONS = [
  ['attributed-write-consults-the-live-user-gate',
    'loadGithubTokenIndex(), ownerId, undefined, loadLiveUserGate());',
    'loadGithubTokenIndex(), ownerId);'],
  ['live-user-gate-is-not-cached',
    'return credentialResolution.buildLiveUserGate(teamsStore.listUsers());',
    'return cached || (cached = credentialResolution.buildLiveUserGate(teamsStore.listUsers()));'],
  ['unreadable-user-index-degrades-to-an-unknown-gate',
    'return credentialResolution.buildLiveUserGate(null);',
    'throw err;'],
  ['sweep-refuses-when-the-live-user-set-is-unknown',
    "if (!liveUsers.known) {", "if (false) {"],
  ['sweep-drives-offboardOwner-not-a-bespoke-cleanup',
    'const result = await this.offboardOwner(ownerId);\n        paused.push(...(result.paused || []));',
    'const result = { paused: [] };\n        await this.disableAgent(ownerId);\n        paused.push(...(result.paused || []));'],
  ['assessment-is-logged-before-the-cleanup-acts',
    '(created ${c.createdAt || \'unknown\'}, fingerprint ${c.fingerprint || \'unknown\'}) ',
    '(created ${c.createdAt || \'unknown\'}) '],
  ['boot-registers-the-sweep-after-init-and-never-blocks',
    '  orchestrator.reconcileOrphanedOffboardings()\n    .catch(',
    '  await orchestrator.reconcileOrphanedOffboardings().catch('],
  ['delete-route-never-reports-a-null-offboarding',
    '        let offboarding;\n', '        let offboarding = null;\n'],
  ['degradation-is-recorded-including-the-partial-case',
    '          recordOffboardingDegradation(resourceId, detail);',
    '          void detail;'],
  ['a-degraded-offboarding-does-not-abort-the-deletion',
    '          recordOffboardingDegradation(resourceId, detail);\n        }',
    '          recordOffboardingDegradation(resourceId, detail);\n          return sendJson(res, 500, { error: detail }), true;\n        }'],
  ['event-log-write-cannot-fail-a-deletion',
    '  } catch (err) {\n    console.error(`[Orchestrator] could not log the offboarding degradation',
    '  } finally {\n    void 0; console.error(`[Orchestrator] could not log the offboarding degradation'],
  ['degradation-event-carries-no-null-agent-outcome',
    '      outcomes: [],\n      noMatchingTrigger: false,',
    '      outcomes: [{ agentId: null, status: \'dropped\' }],\n      noMatchingTrigger: false,'],
];

test('#2138: every wiring check is proven by a mutation that makes exactly it fire', () => {
  const fired = new Set();
  for (const [expected, find, replace] of MUTATIONS) {
    const hits = SRC.split(find).length - 1;
    assert.equal(hits, 1, `mutation anchor for ${expected} matches ${hits}x (must be exactly 1): ${find.slice(0, 70)}`);
    const mutated = SRC.replace(find, replace);
    assert.notEqual(mutated, SRC, `mutation for ${expected} did not change the source`);
    assert.equal(runCheck(mutated), expected, `mutation for ${expected} fired the wrong check`);
    fired.add(expected);
  }
  // No check may be untested — a guard nothing can falsify guards nothing.
  assert.deepEqual([...Object.keys(CHECKS)].filter((k) => !fired.has(k)), []);
});
