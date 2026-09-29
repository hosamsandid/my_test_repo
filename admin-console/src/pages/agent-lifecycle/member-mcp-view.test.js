import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  inheritedMcpRows,
  inheritedMcpPreview,
  switchMcpMode,
  memberMcpSubmitValue,
  memberMcpBlockers,
  sameMcpRows,
} from './member-mcp-view.js';

const SERVERS = [
  { id: 'wiki', name: 'Company Wiki', requiresCredential: true },
  { id: 'clock', name: 'clock', requiresCredential: false },
];
const CREDS = [{ id: 'wiki-team-a', name: 'Wiki (Team A)', serverId: 'wiki' }];
const ENV = {
  id: 'env-a',
  mcpServers: [
    { serverId: 'wiki', credentialId: 'wiki-team-a' },
    { serverId: 'clock', credentialId: null },
  ],
};

test('inheritedMcpRows: the environment set as form rows', () => {
  assert.deepEqual(inheritedMcpRows(ENV), [
    { serverId: 'wiki', credentialId: 'wiki-team-a' },
    { serverId: 'clock', credentialId: '' },
  ]);
  assert.deepEqual(inheritedMcpRows(null), []);
});

test('inheritedMcpPreview: names every inherited pair, not the environment id (AC4)', () => {
  const text = inheritedMcpPreview({ env: ENV, servers: SERVERS, credentials: CREDS });
  assert.equal(text, 'Company Wiki (wiki) · credential: Wiki (Team A)\nclock · no credential');
  assert.doesNotMatch(text, /env-a/);
});

test('inheritedMcpPreview: unknown credential/server fall back to their ids', () => {
  const text = inheritedMcpPreview({ env: { mcpServers: [{ serverId: 'gone', credentialId: 'secret-x' }] }, servers: SERVERS });
  assert.equal(text, 'gone (not registered) · credential: secret-x');
});

test('inheritedMcpPreview: empty, loading and no-environment states', () => {
  assert.match(inheritedMcpPreview({ env: { mcpServers: [] } }), /has no MCP servers/);
  assert.match(inheritedMcpPreview({ env: null, loading: true }), /Loading/);
  assert.match(inheritedMcpPreview({ env: null }), /no environment/);
});

test('switchMcpMode: Custom pre-fills from the inherited set, never an empty list (D1/AC3)', () => {
  const form = { inheritMcp: true, mcpRows: [] };
  const next = switchMcpMode(form, false, ENV);
  assert.equal(next.inheritMcp, false);
  assert.deepEqual(next.mcpRows, inheritedMcpRows(ENV));
  assert.deepEqual(form, { inheritMcp: true, mcpRows: [] }, 'input not mutated');
});

test('switchMcpMode: back to Inherit keeps the rows; re-selecting the current mode is a no-op', () => {
  const custom = { inheritMcp: false, mcpRows: [{ serverId: 'clock', credentialId: '' }] };
  const back = switchMcpMode(custom, true, ENV);
  assert.equal(back.inheritMcp, true);
  assert.deepEqual(back.mcpRows, custom.mcpRows);
  assert.equal(switchMcpMode(custom, false, ENV), custom, 'an edited Custom set is not re-filled');
});

test('memberMcpSubmitValue: null for inherit, refs for Custom, [] stays [] (AC8)', () => {
  assert.equal(memberMcpSubmitValue(true, [{ serverId: 'wiki', credentialId: '' }]), null);
  assert.deepEqual(memberMcpSubmitValue(false, []), []);
  assert.deepEqual(memberMcpSubmitValue(false, [{ serverId: 'wiki', credentialId: '' }]), [{ serverId: 'wiki', credentialId: null }]);
});

test('memberMcpBlockers: a blank row and a duplicate block Custom; Inherit never blocks (AC5)', () => {
  assert.deepEqual(memberMcpBlockers(true, [{ serverId: '', credentialId: '' }]), []);
  assert.deepEqual(memberMcpBlockers(false, [{ serverId: 'wiki', credentialId: '' }]), []);
  const blank = memberMcpBlockers(false, [{ serverId: '', credentialId: 'c' }]);
  assert.deepEqual(blank.map(b => b.field), ['mcpServers']);
  const dup = memberMcpBlockers(false, [{ serverId: 'wiki', credentialId: '' }, { serverId: 'wiki', credentialId: 'x' }]);
  assert.deepEqual(dup.map(b => b.field), ['mcpServersDuplicate']);
  assert.match(dup[0].message, /'wiki' is added twice/);
});

test('sameMcpRows: exact, order-sensitive comparison', () => {
  const a = [{ serverId: 'wiki', credentialId: '' }, { serverId: 'clock', credentialId: '' }];
  assert.equal(sameMcpRows(a, a.map(r => ({ ...r }))), true);
  assert.equal(sameMcpRows(a, [...a].reverse()), false);
  assert.equal(sameMcpRows(a, a.slice(0, 1)), false);
  assert.equal(sameMcpRows(undefined, []), true);
});
