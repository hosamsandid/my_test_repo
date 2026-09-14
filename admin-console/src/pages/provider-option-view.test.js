import test from 'node:test';
import assert from 'node:assert/strict';
import { providerOptionLabel, providerOptionDetail } from './provider-option-view.js';

test('providerOptionLabel keeps an api-key provider unchanged', () => {
  const ep = { id: 'p1', name: 'Local Proxy', baseUrl: 'https://proxy.internal:8080', authType: 'api-key' };
  assert.equal(providerOptionLabel(ep), 'Local Proxy (https://proxy.internal:8080)');
});

test('providerOptionLabel shows the auth type instead of empty brackets for a subscription seat', () => {
  const ep = { id: 'p2', name: 'Claude Enterprise', baseUrl: '', authType: 'oauth-token' };
  assert.equal(providerOptionLabel(ep), 'Claude Enterprise (Subscription)');
});

test('providerOptionLabel treats a legacy record with no authType as api-key', () => {
  const ep = { id: 'p3', name: 'Legacy', baseUrl: '' };
  assert.equal(providerOptionLabel(ep), 'Legacy (API key)');
});

test('providerOptionLabel falls back to the id when the name is blank', () => {
  const ep = { id: 'p4', name: '', baseUrl: '', authType: 'oauth-token' };
  assert.equal(providerOptionLabel(ep), 'p4 (Subscription)');
});

test('providerOptionDetail never renders an empty bracket pair', () => {
  assert.notEqual(providerOptionDetail({ baseUrl: '', authType: 'oauth-token' }), '');
  assert.notEqual(providerOptionDetail({}), '');
});
