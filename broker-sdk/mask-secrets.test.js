'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  REDACTION,
  maskEnvValues,
  maskSecretValues,
  maskSecrets,
  maskSecretsOrDefault,
} = require('./mask-secrets');

test('secret echo: an explicit secret value is redacted wherever it appears', () => {
  const out = 'connecting with token sk-abc123 ... retry with sk-abc123';
  assert.equal(maskSecrets(out, ['sk-abc123']), `connecting with token ${REDACTION} ... retry with ${REDACTION}`);
});

test('secret echo: masks the VALUE half of -e/--env flags, keeps the KEY', () => {
  assert.equal(
    maskEnvValues('podman run -e ANTHROPIC_AUTH_TOKEN=sk-live-xyz --env FOO=bar image'),
    `podman run -e ANTHROPIC_AUTH_TOKEN=${REDACTION} --env FOO=${REDACTION} image`,
  );
});

test('secret echo: env flag with = separator', () => {
  assert.equal(maskEnvValues('--env=KEY=supersecret'), `--env=KEY=${REDACTION}`);
});

test('maskSecrets applies BOTH passes (explicit secret + env flag)', () => {
  const out = 'ran -e API=sk-9 and leaked sk-9 in the body';
  // env-flag pass masks the flag value; explicit-secret pass catches the loose echo too.
  assert.equal(maskSecrets(out, ['sk-9']), `ran -e API=${REDACTION} and leaked ${REDACTION} in the body`);
});

test('blank/undefined secrets never mask everything', () => {
  assert.equal(maskSecretValues('hello world', ['']), 'hello world');
  assert.equal(maskSecretValues('hello world', [undefined, null]), 'hello world');
  assert.equal(maskSecrets('hello world'), 'hello world');
});

test('longest-first so a prefix secret does not leave a longer one exposed', () => {
  assert.equal(maskSecretValues('sk-abcdef', ['sk-abc', 'sk-abcdef']), REDACTION);
});

test('empty/falsy output passes through', () => {
  assert.equal(maskSecrets(''), '');
  assert.equal(maskSecrets(undefined), undefined);
  assert.equal(maskEnvValues(null), null);
});

test('maskSecretsOrDefault falls back only on genuinely empty input', () => {
  assert.equal(maskSecretsOrDefault('', 'fallback'), 'fallback');
  // masking never empties non-empty content:
  assert.equal(maskSecretsOrDefault('-e K=secret', 'fallback'), `-e K=${REDACTION}`);
  assert.equal(maskSecretsOrDefault('token sk-1', 'fallback', ['sk-1']), `token ${REDACTION}`);
});
