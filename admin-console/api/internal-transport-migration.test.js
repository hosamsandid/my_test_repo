const test = require('node:test');
const assert = require('node:assert/strict');

const { planInternalTransportMigration, withoutTransport } = require('./internal-transport-migration');

// #2578 — the startup sweep's pure plan: drop the removed `transport` field from
// channel ports + triggers and name every team whose derived wiring / Outcomes
// block must be re-rendered.

const INTERNAL_BLOCK = [
  'Role text.',
  '',
  '<!-- outcomes:start -->',
  '',
  '## Outcomes',
  '',
  'The label `ready-to-merge` is delivered over the **internal channel**: always announce it with `aee-emit`.',
  '',
  '<!-- outcomes:end -->',
].join('\n');

test('withoutTransport drops the key (any value) and returns the same object when absent', () => {
  const plain = { id: 'a', labelFilter: 'x' };
  assert.equal(withoutTransport(plain), plain, 'no key → same reference');
  assert.deepEqual(withoutTransport({ id: 'a', transport: 'internal' }), { id: 'a' });
  assert.deepEqual(withoutTransport({ id: 'a', transport: 'github' }), { id: 'a' });
  const src = { id: 'a', transport: 'internal' };
  withoutTransport(src);
  assert.equal(src.transport, 'internal', 'the input is not mutated');
  assert.equal(withoutTransport(null), null);
});

test('drops transport from channel ports and triggers, and names the member team', () => {
  const plan = planInternalTransportMigration([
    {
      id: 'acme-reviewer',
      cfg: {
        parentTeamId: 'acme',
        channels: [
          { artifact: 'pr', from: 'acme-dev', label: 'ready-for-review', transport: 'internal' },
          { artifact: 'issue', from: 'acme-ba' },
        ],
      },
      triggers: [
        { id: 'acme-reviewer-on-pr-ready-for-review', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review', channel: true, transport: 'internal' },
        { id: 'nightly', type: 'cron', cron: '0 3 * * *' },
      ],
    },
  ]);
  assert.deepEqual(plan.configs, [{
    id: 'acme-reviewer',
    cfg: {
      parentTeamId: 'acme',
      channels: [
        { artifact: 'pr', from: 'acme-dev', label: 'ready-for-review' },
        { artifact: 'issue', from: 'acme-ba' },
      ],
    },
  }]);
  assert.equal(plan.triggers.length, 1);
  assert.deepEqual(plan.triggers[0].triggers, [
    { id: 'acme-reviewer-on-pr-ready-for-review', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review', channel: true },
    { id: 'nightly', type: 'cron', cron: '0 3 * * *' },
  ], 'the listener is now an ordinary poller-delivered trigger; untouched entries keep their shape');
  assert.deepEqual(plan.teamIds, ['acme']);
});

test('a trigger-only change writes no config, a config-only change writes no triggers', () => {
  const plan = planInternalTransportMigration([
    { id: 'a-dev', cfg: { parentTeamId: 'a' }, triggers: [{ id: 't', type: 'github-event', labelFilter: 'x', transport: 'github' }] },
    { id: 'b-dev', cfg: { parentTeamId: 'b', channels: [{ artifact: 'pr', from: 'b-x', transport: 'internal' }] }, triggers: [] },
  ]);
  assert.deepEqual(plan.configs.map(c => c.id), ['b-dev']);
  assert.deepEqual(plan.triggers.map(t => t.id), ['a-dev']);
  assert.deepEqual(plan.teamIds, ['a', 'b']);
});

test('a team lead (role team) carrying the field is its own team; a standalone agent names none', () => {
  const plan = planInternalTransportMigration([
    { id: 'acme', cfg: { role: 'team' }, triggers: [{ id: 't', type: 'github-event', labelFilter: 'x', transport: 'internal' }] },
    { id: 'solo', cfg: { role: 'agent' }, triggers: [{ id: 't', type: 'github-event', labelFilter: 'y', transport: 'internal' }] },
  ]);
  assert.deepEqual(plan.triggers.map(t => t.id), ['acme', 'solo'], 'both trigger files are cleaned');
  assert.deepEqual(plan.teamIds, ['acme'], 'only the team is re-reconciled');
});

test('a stale aee-emit Outcomes block marks the team even when the fields are already clean', () => {
  // An earlier sweep dropped the fields but was interrupted before the
  // re-render — the rerun must still repair the prompt.
  const plan = planInternalTransportMigration([
    { id: 'acme-dev', cfg: { parentTeamId: 'acme' }, triggers: [], prompt: INTERNAL_BLOCK },
    { id: 'beta-dev', cfg: { parentTeamId: 'beta', systemPrompt: INTERNAL_BLOCK }, triggers: [] },
  ]);
  assert.deepEqual(plan.configs, []);
  assert.deepEqual(plan.triggers, []);
  assert.deepEqual(plan.teamIds, ['acme', 'beta'], 'AGENT-PROMPT.md and a stored exclusive prompt both count');
});

test('aee-emit in authored prompt text outside the generated block does not mark the team', () => {
  const plan = planInternalTransportMigration([
    { id: 'acme-dev', cfg: { parentTeamId: 'acme' }, triggers: [], prompt: 'Never run aee-emit.\n\n<!-- outcomes:start -->\n## Outcomes\napply label `x`\n<!-- outcomes:end -->' },
  ]);
  assert.deepEqual(plan.teamIds, []);
});

test('idempotent: planning over the written result plans nothing', () => {
  const agents = [
    { id: 'acme-reviewer', cfg: { parentTeamId: 'acme', channels: [{ artifact: 'pr', from: 'acme-dev', label: 'r', transport: 'internal' }] },
      triggers: [{ id: 't', type: 'github-event', labelFilter: 'r', transport: 'internal' }] },
  ];
  const first = planInternalTransportMigration(agents);
  const after = agents.map(a => ({
    id: a.id,
    cfg: (first.configs.find(c => c.id === a.id) || a).cfg,
    triggers: (first.triggers.find(t => t.id === a.id) || a).triggers,
  }));
  assert.deepEqual(planInternalTransportMigration(after), { configs: [], triggers: [], teamIds: [] });
});

test('tolerates junk input: missing configs, non-array triggers, empty ids', () => {
  const plan = planInternalTransportMigration([
    null,
    { id: '' },
    { id: 'x', cfg: null, triggers: { not: 'an array' } },
    { id: 'y', cfg: { channels: 'nope' } },
  ]);
  assert.deepEqual(plan, { configs: [], triggers: [], teamIds: [] });
  assert.deepEqual(planInternalTransportMigration(undefined), { configs: [], triggers: [], teamIds: [] });
});
