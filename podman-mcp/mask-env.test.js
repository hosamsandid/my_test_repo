'use strict';
// Run: node --test podman-mcp/mask-env.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { maskEnvValues, maskEnvValuesOrDefault } = require('./mask-env');

test('maskEnvValues masks a single -e KEY=VALUE, keeping the key', () => {
  const out = maskEnvValues('podman run --name=x -e KEY=secret123 -d image');
  assert.equal(out, 'podman run --name=x -e KEY=*** -d image');
});

test('maskEnvValues fully masks a special-character (token-shaped) value', () => {
  const out = maskEnvValues('-e ANTHROPIC_AUTH_TOKEN=sk-ant-ab12/CD34+ef56==');
  assert.equal(out, '-e ANTHROPIC_AUTH_TOKEN=***');
});

test('maskEnvValues leaves a line with no -e/--env flag unchanged', () => {
  const line = 'podman run --name=x -d --network=foo image:latest';
  assert.equal(maskEnvValues(line), line);
});

test('maskEnvValues masks multiple -e flags independently', () => {
  const out = maskEnvValues('podman run -e KEY1=val1 -e KEY2=val2 --env KEY3=val3 image');
  assert.equal(out, 'podman run -e KEY1=*** -e KEY2=*** --env KEY3=*** image');
});

test('maskEnvValues also masks the --env=KEY=VALUE and -e=KEY=VALUE forms', () => {
  assert.equal(maskEnvValues('--env=KEY=secret'), '--env=KEY=***');
  assert.equal(maskEnvValues('-e=KEY=secret'), '-e=KEY=***');
});

test('maskEnvValues returns an empty string unchanged', () => {
  assert.equal(maskEnvValues(''), '');
});

test('maskEnvValues returns non-matching content unchanged', () => {
  assert.equal(maskEnvValues('nothing to see here'), 'nothing to see here');
});

// --- maskEnvValuesOrDefault: the error-path helper used by toolComposeLogs
// when podman-compose exits non-zero (r.code !== 0), so a failing call's
// stderr — which can still contain podman-compose's own verbose -e/--env
// echo from before the failure — is masked before being thrown, exactly
// like the success-path output already was.

test('maskEnvValuesOrDefault masks a secret in a non-empty error message', () => {
  const raw = 'error: -e ANTHROPIC_AUTH_TOKEN=sk-ant-abc123 exec failed: no such file';
  const out = maskEnvValuesOrDefault(raw, 'podman-compose logs failed');
  assert.equal(out, 'error: -e ANTHROPIC_AUTH_TOKEN=*** exec failed: no such file');
});

test('maskEnvValuesOrDefault leaves non-matching non-empty stderr unchanged (no fallback)', () => {
  const raw = 'no such project: scope-a-default';
  assert.equal(maskEnvValuesOrDefault(raw, 'podman-compose logs failed'), raw);
});

test('maskEnvValuesOrDefault falls back only when the original stderr is genuinely empty', () => {
  assert.equal(maskEnvValuesOrDefault('', 'podman-compose logs failed'), 'podman-compose logs failed');
});
