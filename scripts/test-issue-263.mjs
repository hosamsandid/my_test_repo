// Integration test for issue #263 — POST endpoints accept optional `id` field,
// validate it, return 409 on collision, and fall back to name-derived id when
// `id` is omitted (backward compatibility).
//
// Run against the live admin-console API on :4000.

const BASE = process.env.BASE || 'http://localhost:4000';
const failures = [];
const successes = [];

function ok(label) { successes.push(label); console.log('  ✓', label); }
function fail(label, detail) { failures.push({ label, detail }); console.log('  ✗', label, detail ? `\n     -> ${detail}` : ''); }

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  return { status: res.status, body: payload };
}

const STAMP = Date.now().toString(36);

// ───────── SSH KEYS ─────────
console.log('\n# SSH Keys');
{
  const customId = `t263-ssh-custom-${STAMP}`;
  const fallback = `t263-ssh-fallback-${STAMP}`;
  const collide = `t263-ssh-collide-${STAMP}`;

  const dummy = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----';

  // 1) Backward compat: no id supplied → server derives from name
  let r = await api('POST', '/api/ssh-keys', { name: fallback, privateKey: dummy });
  if (r.status === 201 && r.body.id === fallback) ok('SSH no-id → derived from name');
  else fail('SSH no-id → derived from name', `status=${r.status} id=${r.body?.id}`);

  // 2) Custom id supplied → honoured
  r = await api('POST', '/api/ssh-keys', { name: 'Whatever', id: customId, privateKey: dummy });
  if (r.status === 201 && r.body.id === customId) ok('SSH custom id honoured');
  else fail('SSH custom id honoured', `status=${r.status} id=${r.body?.id} body=${JSON.stringify(r.body)}`);

  // 3) Custom id collision → 409
  await api('POST', '/api/ssh-keys', { name: 'first', id: collide, privateKey: dummy });
  r = await api('POST', '/api/ssh-keys', { name: 'second', id: collide, privateKey: dummy });
  if (r.status === 409) ok('SSH duplicate custom id → 409');
  else fail('SSH duplicate custom id → 409', `status=${r.status}`);

  // 4) Invalid id chars → 400
  r = await api('POST', '/api/ssh-keys', { name: 'bad', id: 'BAD ID!', privateKey: dummy });
  if (r.status === 400) ok('SSH invalid id chars → 400');
  else fail('SSH invalid id chars → 400', `status=${r.status}`);

  // cleanup
  for (const id of [customId, fallback, collide]) {
    await api('DELETE', `/api/ssh-keys/${id}`);
  }
}

// ───────── GITHUB TOKENS ─────────
console.log('\n# GitHub Tokens');
{
  const dummy = `ghp_${'A'.repeat(36)}`;
  const customId = `t263-gh-custom-${STAMP}`;
  const fallback = `t263-gh-fallback-${STAMP}`;
  const collide = `t263-gh-collide-${STAMP}`;

  let r = await api('POST', '/api/github-tokens', { name: fallback, token: dummy });
  if (r.status === 201 && r.body.id === fallback) ok('GH no-id → derived from name');
  else fail('GH no-id → derived from name', `status=${r.status} id=${r.body?.id}`);

  r = await api('POST', '/api/github-tokens', { name: 'Whatever', id: customId, token: dummy });
  if (r.status === 201 && r.body.id === customId) ok('GH custom id honoured');
  else fail('GH custom id honoured', `status=${r.status} id=${r.body?.id}`);

  await api('POST', '/api/github-tokens', { name: 'first', id: collide, token: dummy });
  r = await api('POST', '/api/github-tokens', { name: 'second', id: collide, token: dummy });
  if (r.status === 409) ok('GH duplicate custom id → 409');
  else fail('GH duplicate custom id → 409', `status=${r.status}`);

  r = await api('POST', '/api/github-tokens', { name: 'bad', id: 'BAD ID!', token: dummy });
  if (r.status === 400) ok('GH invalid id chars → 400');
  else fail('GH invalid id chars → 400', `status=${r.status}`);

  for (const id of [customId, fallback, collide]) {
    await api('DELETE', `/api/github-tokens/${id}`);
  }
}

// ───────── MCP CREDENTIALS ─────────
console.log('\n# MCP Credentials');
{
  const customId = `t263-mcp-custom-${STAMP}`;
  const fallback = `t263-mcp-fallback-${STAMP}`;
  const collide = `t263-mcp-collide-${STAMP}`;

  let r = await api('POST', '/api/mcp-credentials', { name: fallback, secret: 'topsecret' });
  if (r.status === 201 && r.body.id === fallback) ok('MCP no-id → derived from name');
  else fail('MCP no-id → derived from name', `status=${r.status} id=${r.body?.id}`);

  r = await api('POST', '/api/mcp-credentials', { name: 'Whatever', id: customId, secret: 'topsecret' });
  if (r.status === 201 && r.body.id === customId) ok('MCP custom id honoured');
  else fail('MCP custom id honoured', `status=${r.status} id=${r.body?.id}`);

  await api('POST', '/api/mcp-credentials', { name: 'first', id: collide, secret: 'x' });
  r = await api('POST', '/api/mcp-credentials', { name: 'second', id: collide, secret: 'y' });
  if (r.status === 409) ok('MCP duplicate custom id → 409');
  else fail('MCP duplicate custom id → 409', `status=${r.status}`);

  r = await api('POST', '/api/mcp-credentials', { name: 'bad', id: 'BAD ID!', secret: 'x' });
  if (r.status === 400) ok('MCP invalid id chars → 400');
  else fail('MCP invalid id chars → 400', `status=${r.status}`);

  for (const id of [customId, fallback, collide]) {
    await api('DELETE', `/api/mcp-credentials/${id}`);
  }
}

// ───────── LLM ENDPOINTS ─────────
console.log('\n# LLM Endpoints');
{
  const customId = `t263-ep-custom-${STAMP}`;
  const fallback = `t263-ep-fallback-${STAMP}`;
  const collide = `t263-ep-collide-${STAMP}`;

  let r = await api('POST', '/api/llm-endpoints', {
    name: fallback, baseUrl: 'https://example.invalid/v1', models: [],
  });
  if (r.status === 201 && r.body.id === fallback) ok('LLM no-id → derived from name');
  else fail('LLM no-id → derived from name', `status=${r.status} id=${r.body?.id}`);

  r = await api('POST', '/api/llm-endpoints', {
    name: 'Whatever', id: customId, baseUrl: 'https://example.invalid/v1', models: [],
  });
  if (r.status === 201 && r.body.id === customId) ok('LLM custom id honoured');
  else fail('LLM custom id honoured', `status=${r.status} id=${r.body?.id}`);

  await api('POST', '/api/llm-endpoints', {
    name: 'first', id: collide, baseUrl: 'https://example.invalid/v1', models: [],
  });
  r = await api('POST', '/api/llm-endpoints', {
    name: 'second', id: collide, baseUrl: 'https://example.invalid/v1', models: [],
  });
  if (r.status === 409) ok('LLM duplicate custom id → 409');
  else fail('LLM duplicate custom id → 409', `status=${r.status}`);

  r = await api('POST', '/api/llm-endpoints', {
    name: 'bad', id: 'BAD ID!', baseUrl: 'https://example.invalid/v1', models: [],
  });
  if (r.status === 400) ok('LLM invalid id chars → 400');
  else fail('LLM invalid id chars → 400', `status=${r.status}`);

  for (const id of [customId, fallback, collide]) {
    await api('DELETE', `/api/llm-endpoints/${id}`);
  }
}

// ───────── SUMMARY ─────────
console.log(`\n# Summary: ${successes.length} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL:', f.label, '—', f.detail || '');
  process.exit(1);
}
process.exit(0);
