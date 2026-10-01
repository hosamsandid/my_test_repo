// #2717: live side of a Flow Editor channel rename. The editor PUTs the whole
// `channels` list with the old port renamed; the reconciler regenerates every
// derived listener from that list, so only the new label's listener remains
// (AC3). The PUT normaliser must also keep the authored wake instruction (#868,
// AC8) — it used to drop it on every live channel write.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { expandGithubChannels } = require('./process-template');

const bundle = (channels, triggers = []) => ({
  roles: [
    { id: 'a', github: { producesPr: true }, triggers: [] },
    { id: 'b', channels, triggers },
  ],
});

test('a renamed channel re-derives a listener for the new label only (AC3)', () => {
  const before = expandGithubChannels(bundle([{ artifact: 'pr', from: 'a', label: 'before' }])).roles
    .find(r => r.id === 'b').triggers;
  assert.deepEqual(before.map(t => t.labelFilter), ['before']);
  // Reconcile from the renamed port, starting from the previously derived listener.
  const after = expandGithubChannels(bundle([{ artifact: 'pr', from: 'a', label: 'after' }], before)).roles
    .find(r => r.id === 'b').triggers;
  assert.deepEqual(after.map(t => t.labelFilter), ['after'], 'no listener for the old label remains');
});

test('live PUT /api/agents/:id keeps a channel wakePrompt (AC8)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const start = src.indexOf('if (channels !== undefined) {');
  const block = src.slice(start, src.indexOf('channelsChanged = true;', start));
  assert.match(block,
    /\.\.\.\(typeof c\.wakePrompt === 'string' && c\.wakePrompt\.trim\(\) \? \{ wakePrompt: c\.wakePrompt\.trim\(\) \} : \{\}\),/);
});
