import test from 'node:test';
import assert from 'node:assert/strict';

import { describeWorkingEnvSubmitState } from './working-env-submit-state.js';

// A fully-satisfied environment: name, id, and no dangling repository rows.
const readyEnv = {
  name: 'COBOL Migration',
  id: 'cobol-migration',
  repositories: [{ url: 'git@github.com:acme/cobol.git', branch: '', sshKeyId: 'key-1' }],
};

const fieldsOf = result => result.reasons.map(r => r.field);

/* ── happy paths ─────────────────────────────────────────────────────── */

test('a complete environment with one repo can submit', () => {
  const s = describeWorkingEnvSubmitState(readyEnv);
  assert.equal(s.canSubmit, true);
  assert.deepEqual(s.reasons, []);
});

test('an environment with NO repositories is valid (LLM-only / credential-free)', () => {
  const s = describeWorkingEnvSubmitState({ name: 'LLM Only', id: 'llm-only', repositories: [] });
  assert.equal(s.canSubmit, true);
  assert.deepEqual(s.reasons, []);
});

test('missing repositories key is treated as no repos, not a block', () => {
  const s = describeWorkingEnvSubmitState({ name: 'No Repos', id: 'no-repos' });
  assert.equal(s.canSubmit, true);
  assert.deepEqual(s.reasons, []);
});

/* ── individual unmet requirements ───────────────────────────────────── */

test('missing name blocks submit', () => {
  const s = describeWorkingEnvSubmitState({ ...readyEnv, name: '' });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['name']);
});

test('missing id blocks submit', () => {
  const s = describeWorkingEnvSubmitState({ ...readyEnv, id: '' });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['id']);
});

test('an added-but-blank repository URL blocks submit', () => {
  const s = describeWorkingEnvSubmitState({
    ...readyEnv,
    repositories: [{ url: '', branch: '', sshKeyId: '' }],
  });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['repositories']);
});

test('a whitespace-only repository URL counts as empty', () => {
  const s = describeWorkingEnvSubmitState({
    ...readyEnv,
    repositories: [{ url: '   ', branch: '', sshKeyId: '' }],
  });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['repositories']);
});

test('one good repo plus one blank repo still blocks (every row needs a URL)', () => {
  const s = describeWorkingEnvSubmitState({
    ...readyEnv,
    repositories: [
      { url: 'git@github.com:acme/a.git' },
      { url: '' },
    ],
  });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['repositories']);
});

/* ── ordering + shape ────────────────────────────────────────────────── */

test('reasons follow the form top-to-bottom order (name → id → repositories)', () => {
  const s = describeWorkingEnvSubmitState({
    name: '', id: '', repositories: [{ url: '' }],
  });
  assert.deepEqual(fieldsOf(s), ['name', 'id', 'repositories']);
  for (const r of s.reasons) {
    assert.equal(typeof r.message, 'string');
    assert.ok(r.message.length > 0);
  }
});

test('empty / missing form object is blocked on name + id, never throws', () => {
  const s = describeWorkingEnvSubmitState();
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['name', 'id']);
});

/* ── parity guard: reasons.length === 0 iff the legacy gate would pass ── */

test('canSubmit matches the legacy inline gate across cases', () => {
  const legacyGate = form => {
    const repos = Array.isArray(form.repositories) ? form.repositories : [];
    const reposValid = repos.every(r => String(r?.url ?? '').trim());
    return Boolean(String(form.name ?? '') && String(form.id ?? '') && reposValid);
  };
  const cases = [
    readyEnv,
    { name: '', id: 'x', repositories: [] },
    { name: 'x', id: '', repositories: [] },
    { name: 'x', id: 'x', repositories: [{ url: '' }] },
    { name: 'x', id: 'x', repositories: [{ url: 'a' }, { url: '' }] },
    { name: 'x', id: 'x', repositories: [{ url: 'a' }] },
    { name: '', id: '', repositories: [{ url: '' }] },
    {},
  ];
  for (const c of cases) {
    const s = describeWorkingEnvSubmitState(c);
    assert.equal(s.canSubmit, legacyGate(c), `parity for ${JSON.stringify(c)}`);
    assert.equal(s.reasons.length === 0, legacyGate(c));
  }
});
