import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { webhookCurlExample, WEBHOOK_GITHUB_HINT, WEBHOOK_SECRET_WARNING } from './webhook-hint.js';

test('curl example targets the trigger endpoint on the webhook port with X-Hook-Secret', () => {
  assert.equal(
    webhookCurlExample('/hooks/my-agent/deploy'),
    'curl -X POST -H "X-Hook-Secret: <secret>" http://<host>:4003/hooks/my-agent/deploy',
  );
});

test('GitHub hint explains the signature path, not a custom header', () => {
  assert.match(WEBHOOK_GITHUB_HINT, /X-Hub-Signature-256/);
  assert.match(WEBHOOK_GITHUB_HINT, /"Secret" field/);
  assert.doesNotMatch(WEBHOOK_SECRET_WARNING, /GitHub/);
});

// #651 source guard: the form renders the pure copy, and the old misleading
// "store it as a GitHub webhook secret" sentence next to the header-only
// instruction is gone.
test('TriggersPanel renders the webhook hint from webhook-hint.js', () => {
  const src = fs.readFileSync(new URL('./TriggersPanel.jsx', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/webhook-hint\.js'/);
  assert.match(src, /\{webhookCurlExample\(webhookPath\)\}/);
  assert.match(src, /\{WEBHOOK_GITHUB_HINT\}/);
  assert.match(src, /\{WEBHOOK_SECRET_WARNING\}/);
  assert.doesNotMatch(src, /store it as a GitHub webhook secret/);
});
