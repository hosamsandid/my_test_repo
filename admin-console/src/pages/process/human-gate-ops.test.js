import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_SUFFIX, claimLabelFor, deriveClaim, defaultGateKind, buildGateListener,
} from './human-gate-ops.js';
// The submit sequence moved into the wiring engine (#1002); the adapter-mode
// coverage for the gate gesture lives on here, against the engine entry point.
import { wireHumanGate } from './wiring-engine.js';
import { humansAfterUpsert, humanAfterEmitAdd } from './humans-registry-ops.js';
// The server-side claim convention (CJS, dependency-free) — imported directly
// so a drift between the client mirror and the single source of truth fails
// this suite, not a user's flow.
import serverPt from '../../../api/process-template.js';

// #1000 (Phase 0, D1–D3) — the human→agent gate creation path: exactly one
// event, derived claim, emit recorded on the human role.

// ─── claim convention mirrors the server ────────────────────────────────────

test('deriveClaim matches the server-side convention for every case', () => {
  for (const input of ['ready', ' ready ', 'stage:td', 'ready:wip', '', '   ', null, undefined, 42]) {
    assert.deepEqual(deriveClaim(input), serverPt.deriveClaim(input), `input: ${JSON.stringify(input)}`);
  }
  assert.equal(CLAIM_SUFFIX, serverPt.CLAIM_SUFFIX);
  assert.equal(claimLabelFor('ready'), serverPt.claimLabelFor('ready'));
});

test('deriveClaim derives <label> → <label>:wip and rejects unclaimables', () => {
  assert.deepEqual(deriveClaim('ready'), { remove: 'ready', add: 'ready:wip' });
  assert.equal(deriveClaim('ready:wip'), null); // never claim a claim label
  assert.equal(deriveClaim(''), null);
});

// ─── event kind defaults from what the person reviews ───────────────────────

test('defaultGateKind picks the artifact kind the human consumes', () => {
  assert.equal(defaultGateKind({ consumes: [{ artifact: 'issue', from: 'ba' }] }), 'issues');
  assert.equal(defaultGateKind({ consumes: [{ artifact: 'pr', from: 'dev' }] }), 'pull_request');
  // First artifact consume wins; label/file consumes carry no GitHub kind.
  assert.equal(defaultGateKind({ consumes: [{ label: 'hold' }, { artifact: 'file', name: 'x' }, { artifact: 'pr', from: 'dev' }] }), 'pull_request');
  assert.equal(defaultGateKind({ consumes: [] }), 'issues');
  assert.equal(defaultGateKind(null), 'issues');
});

// ─── the listener payload ───────────────────────────────────────────────────

test('buildGateListener writes exactly ONE event, matching the kind', () => {
  const issue = buildGateListener({ label: 'ready', kind: 'issues' });
  assert.deepEqual(issue.events, ['issues.labeled']);
  const pr = buildGateListener({ label: 'ready', kind: 'pull_request' });
  assert.deepEqual(pr.events, ['pull_request.labeled']);
  // An unknown/absent kind still yields a single issues event, never both.
  assert.deepEqual(buildGateListener({ label: 'ready' }).events, ['issues.labeled']);
});

test('buildGateListener stamps the derived claim in the validator shape', () => {
  const t = buildGateListener({ label: ' ready ', kind: 'issues' });
  assert.equal(t.type, 'github-event');
  assert.equal(t.labelFilter, 'ready');
  assert.deepEqual(t.claim, { remove: 'ready', add: 'ready:wip' });
  assert.equal(t.enabled, true);
  // The claim must satisfy the bundle validator (`add === '<labelFilter>:wip'`).
  assert.equal(serverPt.claimError(t.claim, t.labelFilter, t.type), null);
});

test('buildGateListener omits the claim field when the label is unclaimable', () => {
  const t = buildGateListener({ label: 'ready:wip', kind: 'issues' });
  assert.equal('claim' in t, false); // never persist claim: null
});

// ─── submit against both ops adapters ───────────────────────────────────────

// Live-shaped adapter: records the HTTP-call surface (`createTrigger(to, body)`
// / `addHumanEmit(id, label)`) exactly as edit-adapters' liveOps exposes it.
function liveFakes() {
  const calls = { triggers: [], emits: [] };
  return {
    calls,
    ops: {
      listTriggers: async () => calls.triggers.map(c => c.body),
      createTrigger: async (roleId, body) => { calls.triggers.push({ roleId, body }); return body; },
    },
    humanOps: { addHumanEmit: async (id, label) => { calls.emits.push({ id, label }); } },
  };
}

// Draft-shaped adapter: mutates an in-memory bundle with the same semantics as
// makeDraftOps (append the trigger on the role, upsert the human's emits via
// the shared registry helpers).
function draftFakes(bundle) {
  return {
    ops: {
      listTriggers: async (roleId) => {
        const r = (bundle.roles || []).find(x => x.id === roleId);
        return r ? (r.triggers || []).slice() : [];
      },
      createTrigger: async (roleId, body) => {
        const r = (bundle.roles || []).find(x => x.id === roleId);
        if (!r) throw new Error(`role ${roleId} not found`);
        r.triggers = r.triggers || [];
        const t = { enabled: true, ...body, id: body.id || 't-test' };
        r.triggers.push(t);
        return t;
      },
    },
    humanOps: {
      addHumanEmit: async (id, label) => {
        const human = (bundle.humans || []).find(h => h && h.id === id) || { id, name: id };
        bundle.humans = humansAfterUpsert(bundle.humans, humanAfterEmitAdd(human, label));
      },
    },
  };
}

test('wireHumanGate (live mode): single-event claimed listener on the agent, emit on the human', async () => {
  const { calls, ops, humanOps } = liveFakes();
  await wireHumanGate({ ops, humanOps }, { human: 'ba-human', to: 'developer', label: 'ready', kind: 'issues' });

  assert.deepEqual(calls.emits, [{ id: 'ba-human', label: 'ready' }]);
  assert.equal(calls.triggers.length, 1);
  const { roleId, body } = calls.triggers[0];
  assert.equal(roleId, 'developer');
  assert.deepEqual(body.events, ['issues.labeled']);
  assert.equal(body.labelFilter, 'ready');
  assert.deepEqual(body.claim, { remove: 'ready', add: 'ready:wip' });
});

test('wireHumanGate (draft mode): bundle carries the claimed single-event listener and the gate emit', async () => {
  const bundle = {
    roles: [{ id: 'developer', name: 'Developer' }],
    humans: [{ id: 'ba-human', name: 'BA Human', consumes: [{ artifact: 'pr', from: 'developer' }] }],
  };
  const { ops, humanOps } = draftFakes(bundle);
  await wireHumanGate({ ops, humanOps }, { human: 'ba-human', to: 'developer', label: 'ship-it', kind: 'pull_request' });

  const t = bundle.roles[0].triggers[0];
  assert.deepEqual(t.events, ['pull_request.labeled']);
  assert.equal(t.labelFilter, 'ship-it');
  assert.deepEqual(t.claim, { remove: 'ship-it', add: 'ship-it:wip' });
  // The human's emits gained the gate label; existing consumes survived.
  const human = bundle.humans.find(h => h.id === 'ba-human');
  assert.deepEqual(human.emits, ['ship-it']);
  assert.deepEqual(human.consumes, [{ artifact: 'pr', from: 'developer' }]);
});
