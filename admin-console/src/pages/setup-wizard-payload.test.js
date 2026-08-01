import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLlmProviderPayload, canSaveLlmProvider } from './setup-wizard-payload.js';

test('buildLlmProviderPayload: api-key provider carries baseUrl + optional token', () => {
  const p = buildLlmProviderPayload({
    name: '  Default ', authType: 'api-key', baseUrl: ' https://api.anthropic.com ',
    authToken: '  sk-abc  ', models: [],
  });
  assert.equal(p.name, 'Default');
  assert.equal(p.authType, 'api-key');
  assert.equal(p.baseUrl, 'https://api.anthropic.com');
  assert.equal(p.authToken, 'sk-abc');
  assert.deepEqual(p.models, []);
  assert.ok(!('complianceAck' in p));
  assert.ok(!('oauthFlowId' in p));
});

test('buildLlmProviderPayload: api-key without a token omits authToken', () => {
  const p = buildLlmProviderPayload({ name: 'X', authType: 'api-key', baseUrl: 'https://x', authToken: '' });
  assert.ok(!('authToken' in p));
});

test('buildLlmProviderPayload: oauth provider clears baseUrl and records compliance', () => {
  const p = buildLlmProviderPayload({
    name: 'Sub', authType: 'oauth-token', baseUrl: 'https://ignored',
    complianceAck: true, oauthFlowId: 'flow-123', models: [],
  });
  assert.equal(p.authType, 'oauth-token');
  assert.equal(p.baseUrl, '');
  assert.equal(p.complianceAck, true);
  assert.equal(p.oauthFlowId, 'flow-123');
  assert.ok(!('authToken' in p));
});

test('buildLlmProviderPayload: oauth pasted token wins over the login flow', () => {
  const p = buildLlmProviderPayload({
    name: 'Sub', authType: 'oauth-token', complianceAck: true,
    authToken: 'sk-ant-oat-xyz', oauthFlowId: 'flow-123',
  });
  assert.equal(p.authToken, 'sk-ant-oat-xyz');
  assert.ok(!('oauthFlowId' in p));
});

test('buildLlmProviderPayload: oauth without compliance omits the ack', () => {
  const p = buildLlmProviderPayload({
    name: 'Sub', authType: 'oauth-token', complianceAck: false, oauthFlowId: 'flow-1',
  });
  assert.ok(!('complianceAck' in p));
});

test('buildLlmProviderPayload: model rows are trimmed, blanks dropped, displayName defaulted', () => {
  const p = buildLlmProviderPayload({
    name: 'X', authType: 'api-key', baseUrl: 'https://x',
    models: [
      { id: ' claude-sonnet-4-6 ', displayName: '', kind: 'sonnet' },
      { id: '', displayName: 'blank' },
      { id: 'm2', displayName: ' Two ' },
    ],
  });
  assert.deepEqual(p.models, [
    { id: 'claude-sonnet-4-6', displayName: 'claude-sonnet-4-6', kind: 'sonnet' },
    { id: 'm2', displayName: 'Two' },
  ]);
});

test('canSaveLlmProvider: api-key needs name + baseUrl', () => {
  assert.equal(canSaveLlmProvider({ name: 'X', authType: 'api-key', baseUrl: 'https://x' }), true);
  assert.equal(canSaveLlmProvider({ name: '', authType: 'api-key', baseUrl: 'https://x' }), false);
  assert.equal(canSaveLlmProvider({ name: 'X', authType: 'api-key', baseUrl: '' }), false);
});

test('canSaveLlmProvider: oauth needs name + compliance + a token source', () => {
  assert.equal(canSaveLlmProvider({ name: 'X', authType: 'oauth-token', complianceAck: true, oauthFlowId: 'f' }), true);
  assert.equal(canSaveLlmProvider({ name: 'X', authType: 'oauth-token', complianceAck: true, authToken: 'sk-ant-oat' }), true);
  assert.equal(canSaveLlmProvider({ name: 'X', authType: 'oauth-token', complianceAck: false, oauthFlowId: 'f' }), false);
  assert.equal(canSaveLlmProvider({ name: 'X', authType: 'oauth-token', complianceAck: true }), false);
  assert.equal(canSaveLlmProvider({ name: '', authType: 'oauth-token', complianceAck: true, oauthFlowId: 'f' }), false);
});
