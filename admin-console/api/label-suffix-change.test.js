'use strict';

// #2858 — a live team's label suffix as one central setting: the team-label
// split (isTeamLabel / teamForeignLabels), foreign labels surviving live edits
// unstamped (stampLiveLabels `keep`), and the pure suffix-change planner.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyLabelSuffix,
  stampLiveLabels,
  isTeamLabel,
  teamForeignLabels,
  planSuffixChange,
} = require('./label-suffix');

// A small live team stamped with `k3f9`: the team agent (registries + team
// prompt), a developer and a reviewer, plus one foreign label (`external-qa`)
// that was never stamped.
function team(overrides = {}) {
  return [
    {
      id: 't',
      config: {
        role: 'team',
        labelSuffix: 'k3f9',
        systemPromptTemplate: 'Never touch `ready-prod-k3f9` yourself. Bare ready stays.',
        labels: [{ name: 'ready-prod-k3f9', humanGate: true }, { name: 'external-qa' }],
        humans: [{ id: 'po', name: 'PO', emits: ['ready-prod-k3f9'], consumes: [{ label: 'ready-for-review-k3f9' }, { from: 't-dev' }] }],
        ...overrides,
      },
      triggers: [],
    },
    {
      id: 't-dev',
      config: {
        role: 'team-member',
        parentTeamId: 't',
        promptMode: 'exclusive',
        systemPrompt: 'When done, apply ready-for-review-k3f9. Do not use ready-for-review-k3f9x.',
        outcomes: { mode: 'anyOf', options: [{ id: 'pr', title: 'PR', actions: [{ type: 'setLabel', label: 'ready-for-review-k3f9' }] }] },
      },
      triggers: [{
        id: 'w', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready-prod-k3f9',
        claim: { remove: 'ready-prod-k3f9', add: 'ready-prod-k3f9:wip' },
        prompt: 'A human applied `ready-prod-k3f9` — proceed.',
      }],
    },
    {
      id: 't-rev',
      config: {
        role: 'team-member',
        parentTeamId: 't',
        channels: [{ artifact: 'pr', from: 't-dev', label: 'ready-for-review-k3f9' }],
      },
      triggers: [{ id: 'q', type: 'github-event', events: ['issues.labeled'], labelFilter: 'external-qa' }],
    },
  ];
}

describe('isTeamLabel', () => {
  it('is a team label when it ends in -<suffix> and is not exempt', () => {
    assert.equal(isTeamLabel('foo-k3f9', 'k3f9'), true);
    assert.equal(isTeamLabel('foo', 'k3f9'), false);
    assert.equal(isTeamLabel('-k3f9', 'k3f9'), false);
    assert.equal(isTeamLabel('foo-k3f9', ''), false);
  });

  it('never splits an exempt label that merely looks suffixed (edge case: suffix 1, label team-1)', () => {
    assert.equal(isTeamLabel('team-1', '1', ['team-1']), false);
    assert.equal(isTeamLabel('team-1-1', '1', ['team-1']), true);
  });
});

describe('creation records labels that already ended in the suffix', () => {
  it('applyLabelSuffix reports them as skipped', () => {
    const out = applyLabelSuffix([{ emits: ['team-1', 'done'] }], [], '1');
    assert.deepEqual(out.skipped, ['team-1']);
    assert.deepEqual(out.members[0].emits, ['team-1', 'done-1']);
  });
});

describe('teamForeignLabels (AC4)', () => {
  it('lists the labels of a suffixed team that are not team labels', () => {
    assert.deepEqual([...teamForeignLabels(team(), 't')], ['external-qa']);
  });

  it('includes exempt labels and is empty for an unsuffixed team', () => {
    const exempt = team({ labelSuffixExempt: ['ready-prod-k3f9'] });
    assert.deepEqual([...teamForeignLabels(exempt, 't')].sort(), ['external-qa', 'ready-prod-k3f9']);
    assert.equal(teamForeignLabels(team({ labelSuffix: undefined }), 't').size, 0);
  });
});

describe('stampLiveLabels keep (AC4)', () => {
  it('writes a kept foreign label back unstamped and stamps the rest', () => {
    const body = { outcomes: { mode: 'anyOf', options: [
      { id: 'a', actions: [{ type: 'setLabel', label: 'external-qa' }] },
      { id: 'b', actions: [{ type: 'setLabel', label: 'new-label' }] },
    ] } };
    const out = stampLiveLabels(body, 'k3f9', { keep: new Set(['external-qa']) });
    assert.deepEqual(out.outcomes.options.map(o => o.actions[0].label), ['external-qa', 'new-label-k3f9']);
  });

  it('stays idempotent for a label the console already sends as <base>-<suffix> (AC2/AC3)', () => {
    const out = stampLiveLabels({ labelFilter: 'foo-k3f9', claim: { remove: 'foo-k3f9', add: 'foo-k3f9:wip' } }, 'k3f9', { trigger: true });
    assert.equal(out.labelFilter, 'foo-k3f9');
    assert.deepEqual(out.claim, { remove: 'foo-k3f9', add: 'foo-k3f9:wip' });
  });
});

describe('planSuffixChange (AC7)', () => {
  const plan = planSuffixChange(team(), 't', 'x1');
  const byId = Object.fromEntries(plan.agents.map(a => [a.id, a]));

  it('renames every team label and nothing else', () => {
    assert.deepEqual(plan.renames.sort((a, b) => a.from.localeCompare(b.from)), [
      { from: 'ready-for-review-k3f9', to: 'ready-for-review-x1' },
      { from: 'ready-prod-k3f9', to: 'ready-prod-x1' },
    ]);
    assert.deepEqual(plan.collisions, []);
  });

  it('rewrites triggers, claim, channel, outcomes and both registries', () => {
    const w = byId['t-dev'].triggers[0];
    assert.equal(w.labelFilter, 'ready-prod-x1');
    assert.deepEqual(w.claim, { remove: 'ready-prod-x1', add: 'ready-prod-x1:wip' });
    assert.equal(byId['t-dev'].config.outcomes.options[0].actions[0].label, 'ready-for-review-x1');
    assert.equal(byId['t-rev'].config.channels[0].label, 'ready-for-review-x1');
    assert.deepEqual(byId.t.config.labels, [{ name: 'ready-prod-x1', humanGate: true }, { name: 'external-qa' }]);
    assert.deepEqual(byId.t.config.humans[0].emits, ['ready-prod-x1']);
    assert.deepEqual(byId.t.config.humans[0].consumes, [{ label: 'ready-for-review-x1' }, { from: 't-dev' }]);
  });

  it('rewrites prompt text with the same token rules — never inside a longer name', () => {
    assert.equal(byId.t.config.systemPromptTemplate, 'Never touch `ready-prod-x1` yourself. Bare ready stays.');
    assert.equal(byId['t-dev'].config.systemPrompt,
      'When done, apply ready-for-review-x1. Do not use ready-for-review-k3f9x.');
    assert.equal(byId['t-dev'].triggers[0].prompt, 'A human applied `ready-prod-x1` — proceed.');
  });

  it('leaves a foreign label alone and stores the new suffix on the team', () => {
    assert.equal(byId['t-rev'].triggers[0].labelFilter, 'external-qa');
    assert.equal(byId.t.config.labelSuffix, 'x1');
    assert.equal(byId['t-rev'].configChanged, true);
    assert.equal(byId['t-rev'].triggersChanged, false);
  });
});

describe('planSuffixChange — set and remove a suffix (AC11)', () => {
  it('removing the suffix strips it everywhere and drops the stored suffix', () => {
    const plan = planSuffixChange(team(), 't', '');
    const t = plan.agents.find(a => a.id === 't');
    assert.equal('labelSuffix' in t.config, false);
    assert.equal(plan.agents.find(a => a.id === 't-dev').triggers[0].claim.add, 'ready-prod:wip');
  });

  it('setting a suffix on an unsuffixed team stamps every label like creation', () => {
    const plain = planSuffixChange(planSuffixChange(team(), 't', '').agents, 't', 'ab');
    const dev = plain.agents.find(a => a.id === 't-dev');
    assert.equal(dev.triggers[0].labelFilter, 'ready-prod-ab');
    // With no suffix every label is a team label, the formerly foreign one too.
    assert.equal(plain.agents.find(a => a.id === 't-rev').triggers[0].labelFilter, 'external-qa-ab');
    assert.equal(plain.agents.find(a => a.id === 't').config.labelSuffix, 'ab');
  });

  it('a label that already ends in the new suffix is left as is and recorded exempt', () => {
    const agents = [
      { id: 't', config: { role: 'team' }, triggers: [] },
      { id: 't-a', config: { role: 'team-member', parentTeamId: 't', emits: ['team-1', 'done'] }, triggers: [] },
    ];
    const plan = planSuffixChange(agents, 't', '1');
    assert.deepEqual(plan.renames, [{ from: 'done', to: 'done-1' }]);
    assert.deepEqual(plan.agents[0].config.labelSuffixExempt, ['team-1']);
  });

  it('does not rewrite a bare dash-free prompt word', () => {
    const agents = [
      { id: 't', config: { role: 'team', systemPromptTemplate: 'Apply `ready`; ready is a word.' }, triggers: [] },
      { id: 't-a', config: { role: 'team-member', parentTeamId: 't', emits: ['ready'] }, triggers: [] },
    ];
    const t = planSuffixChange(agents, 't', 'zz').agents[0];
    assert.equal(t.config.systemPromptTemplate, 'Apply `ready-zz`; ready is a word.');
  });
});

describe('planSuffixChange — collisions (AC10)', () => {
  it('reports a resulting name another team on the repo already uses', () => {
    const plan = planSuffixChange(team(), 't', 'x1', { otherTeamLabels: ['ready-prod-x1'] });
    assert.deepEqual(plan.collisions, [{ label: 'ready-prod-x1', from: 'ready-prod-k3f9', owner: 'other-team' }]);
  });

  it('reports a resulting name that would merge into the team\'s own foreign label', () => {
    const agents = team();
    agents[2].triggers[0].labelFilter = 'ready-prod';
    const plan = planSuffixChange(agents, 't', '');
    assert.deepEqual(plan.collisions, [{ label: 'ready-prod', from: 'ready-prod-k3f9', owner: 'this-team' }]);
  });
});
