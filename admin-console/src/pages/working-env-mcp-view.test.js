import test from 'node:test';
import assert from 'node:assert/strict';

import {
  initialMcpRows,
  mcpWireRows,
  sameMcpSelection,
  mcpSubmitValue,
  mcpRowHint,
  mcpChangeNotice,
  mcpServerLabel,
} from './working-env-mcp-view.js';

const SERVERS = [
  { id: 'wiki', name: 'Company Wiki', requiresCredential: true },
  { id: 'clock', name: 'clock', requiresCredential: false },
];

// ── initialMcpRows ──────────────────────────────────────────────────────────

test('initialMcpRows: a creating form starts with no rows', () => {
  assert.deepEqual(initialMcpRows(null), []);
  assert.deepEqual(initialMcpRows(undefined), []);
  assert.deepEqual(initialMcpRows({}), []);
});

test('initialMcpRows: a stored null credential becomes the empty select value', () => {
  // The trap this pins: String(null) is "null", which would render as a
  // selected option that does not exist and submit back as a credential id.
  assert.deepEqual(
    initialMcpRows({ mcpServers: [{ serverId: 'wiki', credentialId: null }] }),
    [{ serverId: 'wiki', credentialId: '' }],
  );
});

test('initialMcpRows: a hand-written ref with no credentialId key is accepted', () => {
  assert.deepEqual(
    initialMcpRows({ mcpServers: [{ serverId: 'wiki' }] }),
    [{ serverId: 'wiki', credentialId: '' }],
  );
});

test('initialMcpRows: non-object entries are skipped, order is kept', () => {
  assert.deepEqual(
    initialMcpRows({ mcpServers: [null, { serverId: 'clock' }, 'wiki', { serverId: 'wiki' }] }),
    [{ serverId: 'clock', credentialId: '' }, { serverId: 'wiki', credentialId: '' }],
  );
});

// ── mcpWireRows ─────────────────────────────────────────────────────────────

test('mcpWireRows: form rows become the stored shape, blank credential → null', () => {
  assert.deepEqual(
    mcpWireRows([{ serverId: 'wiki', credentialId: 'wiki-token' }, { serverId: 'clock', credentialId: '' }]),
    [{ serverId: 'wiki', credentialId: 'wiki-token' }, { serverId: 'clock', credentialId: null }],
  );
});

test('mcpWireRows: a row with no server chosen is dropped', () => {
  // What an "Add MCP server" click leaves behind before anything is picked.
  assert.deepEqual(mcpWireRows([{ serverId: '', credentialId: 'c1' }]), []);
});

test('mcpWireRows: tolerates a non-array', () => {
  assert.deepEqual(mcpWireRows(undefined), []);
  assert.deepEqual(mcpWireRows(null), []);
});

// ── sameMcpSelection ────────────────────────────────────────────────────────

test('sameMcpSelection: absent vs empty vs [] all mean "no pairs"', () => {
  assert.equal(sameMcpSelection(undefined, []), true);
  assert.equal(sameMcpSelection([], []), true);
  assert.equal(sameMcpSelection(null, []), true);
});

test('sameMcpSelection: a missing credentialId key equals an explicit null', () => {
  assert.equal(
    sameMcpSelection([{ serverId: 'wiki' }], [{ serverId: 'wiki', credentialId: null }]),
    true,
  );
});

test('sameMcpSelection: order is significant', () => {
  const a = [{ serverId: 'wiki', credentialId: null }, { serverId: 'clock', credentialId: null }];
  const b = [{ serverId: 'clock', credentialId: null }, { serverId: 'wiki', credentialId: null }];
  assert.equal(sameMcpSelection(a, b), false);
});

test('sameMcpSelection: a changed credential is a change', () => {
  assert.equal(
    sameMcpSelection([{ serverId: 'wiki', credentialId: 'a' }], [{ serverId: 'wiki', credentialId: 'b' }]),
    false,
  );
  assert.equal(
    sameMcpSelection([{ serverId: 'wiki', credentialId: 'a' }], [{ serverId: 'wiki', credentialId: null }]),
    false,
  );
});

// ── mcpSubmitValue — the AC2 guarantee ──────────────────────────────────────

test('mcpSubmitValue: an untouched selection sends nothing at all', () => {
  // AC2. `undefined` means the key is left OUT of the PUT body, and
  // PUT /api/environments/:id only writes mcpServers when the key is present —
  // so the stored value keeps its exact bytes through an unrelated save.
  const initial = { mcpServers: [{ serverId: 'wiki', credentialId: 'wiki-token' }] };
  assert.equal(mcpSubmitValue(initial, initialMcpRows(initial)), undefined);
});

test('mcpSubmitValue: an environment that never had the field still sends nothing', () => {
  assert.equal(mcpSubmitValue({ id: 'e1' }, []), undefined);
  assert.equal(mcpSubmitValue(null, []), undefined);
});

test('mcpSubmitValue: a legacy ref missing credentialId is not rewritten by an unrelated save', () => {
  // Without the change gate this would send {serverId, credentialId: null} and
  // silently add a key to a hand-written record.
  const initial = { mcpServers: [{ serverId: 'wiki' }] };
  assert.equal(mcpSubmitValue(initial, initialMcpRows(initial)), undefined);
});

test('mcpSubmitValue: a real edit sends the full normalized list', () => {
  const initial = { mcpServers: [{ serverId: 'wiki', credentialId: 'wiki-token' }] };
  const rows = [...initialMcpRows(initial), { serverId: 'clock', credentialId: '' }];
  assert.deepEqual(mcpSubmitValue(initial, rows), [
    { serverId: 'wiki', credentialId: 'wiki-token' },
    { serverId: 'clock', credentialId: null },
  ]);
});

test('mcpSubmitValue: clearing every pair sends an explicit empty array', () => {
  // Not `undefined` — the user removed the rows and the field must be written.
  const initial = { mcpServers: [{ serverId: 'wiki', credentialId: null }] };
  assert.deepEqual(mcpSubmitValue(initial, []), []);
});

test('mcpSubmitValue: adding a blank row alone is not a change', () => {
  const initial = { mcpServers: [{ serverId: 'wiki', credentialId: null }] };
  const rows = [...initialMcpRows(initial), { serverId: '', credentialId: '' }];
  assert.equal(mcpSubmitValue(initial, rows), undefined);
});

// ── mcpRowHint — the seeder's silent rules, surfaced at choice time ─────────

test('mcpRowHint: an ordinary pair is unremarkable', () => {
  assert.equal(mcpRowHint({ serverId: 'wiki', credentialId: 'c1' }, SERVERS), null);
  assert.equal(mcpRowHint({ serverId: 'clock', credentialId: '' }, SERVERS), null);
});

test('mcpRowHint: a blank row says nothing', () => {
  assert.equal(mcpRowHint({ serverId: '', credentialId: '' }, SERVERS), null);
});

test('mcpRowHint: a credential-needing server with none bound warns about the dropped key', () => {
  const hint = mcpRowHint({ serverId: 'wiki', credentialId: '' }, SERVERS);
  assert.equal(hint.tone, 'warn');
  assert.match(hint.message, /unauthenticated/);
});

test('mcpRowHint: a credential on a placeholder-less template is called out as ignored', () => {
  const hint = mcpRowHint({ serverId: 'clock', credentialId: 'c1' }, SERVERS);
  assert.equal(hint.tone, 'info');
  assert.match(hint.message, /ignored/);
});

test('mcpRowHint: a server that is no longer registered warns rather than rendering blank', () => {
  const hint = mcpRowHint({ serverId: 'gone', credentialId: '' }, SERVERS);
  assert.equal(hint.tone, 'warn');
  assert.match(hint.message, /'gone'/);
  // Also holds while the server list is still loading — the row must not claim
  // a credential problem it cannot know about yet.
  assert.equal(mcpRowHint({ serverId: 'wiki', credentialId: '' }, []).tone, 'warn');
});

// ── mcpChangeNotice — the AC3 seed-time caveat ──────────────────────────────

test('mcpChangeNotice: silent while creating', () => {
  assert.equal(mcpChangeNotice({ isEdit: false, initial: null, rows: [{ serverId: 'wiki' }] }), null);
});

test('mcpChangeNotice: silent while the selection is unchanged', () => {
  const initial = { mcpServers: [{ serverId: 'wiki', credentialId: null }] };
  assert.equal(
    mcpChangeNotice({ isEdit: true, initial, rows: initialMcpRows(initial), agentCount: 3 }),
    null,
  );
});

test('mcpChangeNotice: a change with existing agents names them and says what to do', () => {
  const notice = mcpChangeNotice({
    isEdit: true,
    initial: { mcpServers: [] },
    rows: [{ serverId: 'wiki', credentialId: '' }],
    agentCount: 3,
  });
  assert.match(notice, /3 agents/);
  assert.match(notice, /recreate an agent/);
  // It must NOT promise a restart — nothing respawns on an MCP change.
  assert.doesNotMatch(notice, /restart/i);
});

test('mcpChangeNotice: singular agent reads correctly', () => {
  const notice = mcpChangeNotice({
    isEdit: true,
    initial: { mcpServers: [] },
    rows: [{ serverId: 'wiki', credentialId: '' }],
    agentCount: 1,
  });
  assert.match(notice, /1 agent already/);
  assert.match(notice, /keeps the set it was created with/);
});

test('mcpChangeNotice: with no agents yet it does not threaten an interruption', () => {
  const notice = mcpChangeNotice({
    isEdit: true,
    initial: { mcpServers: [] },
    rows: [{ serverId: 'wiki', credentialId: '' }],
    agentCount: 0,
  });
  assert.match(notice, /agents created from now on/);
  assert.doesNotMatch(notice, /recreate/);
});

// ── mcpServerLabel ──────────────────────────────────────────────────────────

test('mcpServerLabel: name and id, or the id alone when they are the same', () => {
  assert.equal(mcpServerLabel('wiki', SERVERS), 'Company Wiki (wiki)');
  assert.equal(mcpServerLabel('clock', SERVERS), 'clock');
});

test('mcpServerLabel: an unregistered id stays visible and is marked', () => {
  assert.equal(mcpServerLabel('gone', SERVERS), 'gone (not registered)');
});
