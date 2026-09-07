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

/* ── MCP picker rows (#2051) ─────────────────────────────────────────── */

test('an environment with no MCP rows is valid — the picker is optional', () => {
  const s = describeWorkingEnvSubmitState({ ...readyEnv, mcpServers: [] });
  assert.equal(s.canSubmit, true);
  assert.deepEqual(s.reasons, []);
});

test('a complete MCP row can submit, with or without a credential', () => {
  const withCred = describeWorkingEnvSubmitState({
    ...readyEnv,
    mcpServers: [{ serverId: 'wiki', credentialId: 'wiki-token' }],
  });
  assert.equal(withCred.canSubmit, true);
  // A credential-less pair is legitimate: the server is still seeded, just
  // unauthenticated. That is a hint on the row, never a submit block.
  const withoutCred = describeWorkingEnvSubmitState({
    ...readyEnv,
    mcpServers: [{ serverId: 'wiki', credentialId: '' }],
  });
  assert.equal(withoutCred.canSubmit, true);
});

test('an MCP row with no server chosen blocks submit', () => {
  const s = describeWorkingEnvSubmitState({
    ...readyEnv,
    mcpServers: [{ serverId: '', credentialId: 'wiki-token' }],
  });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['mcpServers']);
  assert.match(s.reasons[0].message, /remove the empty row/);
});

test('the same MCP server listed twice blocks submit and names it', () => {
  const s = describeWorkingEnvSubmitState({
    ...readyEnv,
    mcpServers: [{ serverId: 'wiki', credentialId: 'a' }, { serverId: 'wiki', credentialId: 'b' }],
  });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['mcpServersDuplicate']);
  assert.match(s.reasons[0].message, /'wiki'/);
});

test('two blank MCP rows are one blank complaint, not a duplicate complaint', () => {
  // The duplicate check must run over CHOSEN servers only, or two fresh rows
  // would report "listed twice" about the empty string.
  const s = describeWorkingEnvSubmitState({
    ...readyEnv,
    mcpServers: [{ serverId: '' }, { serverId: '' }],
  });
  assert.deepEqual(fieldsOf(s), ['mcpServers']);
});

test('the MCP reasons come last and each field key is unique', () => {
  // The form renders the reasons as <li key={r.field}> in form order, so the
  // ordering is the top-to-bottom reading and the keys must not collide.
  const s = describeWorkingEnvSubmitState({
    name: '', id: '',
    repositories: [{ url: '' }],
    mcpServers: [{ serverId: '' }, { serverId: 'wiki' }, { serverId: 'wiki' }],
  });
  assert.deepEqual(fieldsOf(s), ['name', 'id', 'repositories', 'mcpServers', 'mcpServersDuplicate']);
  assert.equal(new Set(fieldsOf(s)).size, fieldsOf(s).length);
});

test('a non-array mcpServers is treated as no rows, not a block', () => {
  assert.equal(describeWorkingEnvSubmitState({ ...readyEnv, mcpServers: null }).canSubmit, true);
  assert.equal(describeWorkingEnvSubmitState({ ...readyEnv, mcpServers: 'wiki' }).canSubmit, true);
});
