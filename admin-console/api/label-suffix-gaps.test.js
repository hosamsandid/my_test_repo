'use strict';

// Label-suffix gaps (#2718): trigger claims, double-stamping inside longer
// label names, the humans registry, and labels added to a live suffixed team.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { applyLabelSuffix, stampLiveLabels } = require('./label-suffix');
const {
  templateToCustomRoles, expandDataFlowSteps, expandGithubChannels, expandWakeHandoffs,
  liftTriggerEmits, normalizeLegacyReview, normalizeHumans, remapHumanConsumesFrom,
} = require('./process-template');

const S = 'x1';

// The create handlers' pipeline (api.js POST /api/teams), minus the I/O.
function materialise(bundle, teamId = 'team') {
  return templateToCustomRoles(
    expandDataFlowSteps(
      expandGithubChannels(
        expandWakeHandoffs(liftTriggerEmits(normalizeLegacyReview(bundle))),
        { teamId },
      ),
      { teamId },
    ),
  );
}

const labelTrigger = (labelFilter, extra = {}) => ({
  id: `t-${labelFilter}`, type: 'github-event', events: ['issues.labeled'], labelFilter, ...extra,
});

// Every string in a (nested) value, with its path — for "no token left behind".
function strings(v, at = '$', out = []) {
  if (typeof v === 'string') out.push([at, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${at}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, `${at}.${k}`, out);
  return out;
}

describe('trigger claim stamping (AC1)', () => {
  it('stamps claim.remove / claim.add to match the stamped labelFilter, keeping the postcondition', () => {
    const members = [{
      id: 'dev',
      triggers: [labelTrigger('spec-required', {
        claim: { remove: 'spec-required', add: 'spec-required:wip', postcondition: 'pr-opened' },
      })],
    }];
    const t = applyLabelSuffix(members, [], S).members[0].triggers[0];
    assert.equal(t.labelFilter, 'spec-required-x1');
    assert.deepEqual(t.claim, { remove: 'spec-required-x1', add: 'spec-required-x1:wip', postcondition: 'pr-opened' });
  });

  it('keeps an author-chosen claim ending and stamps only the base label', () => {
    const members = [{ id: 'dev', triggers: [labelTrigger('ready', { claim: { remove: 'ready', add: 'ready/in-progress' } })] }];
    const t = applyLabelSuffix(members, [], S).members[0].triggers[0];
    assert.deepEqual(t.claim, { remove: 'ready-x1', add: 'ready-x1/in-progress' });
  });

  it('leaves a claim naming an unknown label unchanged', () => {
    const members = [{ id: 'dev', triggers: [labelTrigger('ready', { claim: { remove: 'external', add: 'external:wip' } })] }];
    const t = applyLabelSuffix(members, [], S).members[0].triggers[0];
    assert.equal(t.labelFilter, 'ready-x1');
    assert.deepEqual(t.claim, { remove: 'external', add: 'external:wip' });
  });

  it('a claim with a known label that differs from labelFilter is stamped', () => {
    const members = [
      { id: 'a', emits: ['other-label'] },
      { id: 'b', triggers: [labelTrigger('ready', { claim: { remove: 'other-label', add: 'other-label:wip' } })] },
    ];
    const t = applyLabelSuffix(members, [], S).members[1].triggers[0];
    assert.deepEqual(t.claim, { remove: 'other-label-x1', add: 'other-label-x1:wip' });
  });
});

describe('channel-derived claims (AC2)', () => {
  it('each autoClaim listener claims exactly its stamped labelFilter', () => {
    const members = materialise({
      processTemplateVersion: 1,
      roles: [
        { id: 'ba', displayName: 'BA', github: { producesIssue: true }, systemPrompt: 'Write specs.' },
        { id: 'dev', displayName: 'Dev', systemPrompt: 'Build.', channels: [
          { artifact: 'issue', from: 'ba', label: 'spec-required' },
          { artifact: 'issue', from: 'ba', label: 'ready', gate: 'human' },
        ] },
      ],
    });
    const before = members.find(m => m.id === 'dev').triggers.filter(t => t.claim);
    assert.ok(before.length >= 2, 'the expander derived claims for both channels');
    const dev = applyLabelSuffix(members, [], S).members.find(m => m.id === 'dev');
    const claimed = dev.triggers.filter(t => t.claim);
    for (const t of claimed) {
      assert.ok(t.labelFilter.endsWith('-x1'), t.labelFilter);
      assert.equal(t.claim.remove, t.labelFilter);
      assert.equal(t.claim.add, `${t.labelFilter}:wip`);
    }
  });
});

describe('no stamping inside a longer label name (AC4)', () => {
  const members = [
    { id: 'a', emits: ['foo', 'foo-abc'], promptTemplate: 'Apply `foo` or foo-abc; never foo-abc-x1-ish. Then foo-abc.' },
    { id: 'b', triggers: [labelTrigger('foo-abc', { promptTemplate: 'Woken by foo-abc (not `foo`).' })] },
  ];
  const out = applyLabelSuffix(members, [{ name: 'foo' }, { name: 'foo-abc' }], S);

  it('ports carry exactly foo-x1 and foo-abc-x1', () => {
    assert.deepEqual(out.members[0].emits, ['foo-x1', 'foo-abc-x1']);
    assert.equal(out.members[1].triggers[0].labelFilter, 'foo-abc-x1');
    assert.deepEqual(out.bundleLabels.map(l => l.name), ['foo-x1', 'foo-abc-x1']);
  });

  it('prompt text never carries the suffix twice or between name parts', () => {
    const texts = [out.members[0].promptTemplate, out.members[1].triggers[0].promptTemplate];
    assert.equal(out.members[0].promptTemplate, 'Apply `foo-x1` or foo-abc-x1; never foo-abc-x1-ish. Then foo-abc-x1.');
    assert.equal(out.members[1].triggers[0].promptTemplate, 'Woken by foo-abc-x1 (not `foo-x1`).');
    for (const t of texts) {
      assert.doesNotMatch(t, /x1-\w*-x1|x1-x1/);
      assert.doesNotMatch(t, /foo-x1-abc/);
    }
  });

  it('a label that is a prefix of another is stamped on its own only', () => {
    const r = applyLabelSuffix(
      [{ id: 'a', emits: ['ready-to-review', 'ready-to-review-later'], promptTemplate: 'Use ready-to-review or ready-to-review-later.' }],
      [], S,
    );
    assert.equal(r.members[0].promptTemplate, 'Use ready-to-review-x1 or ready-to-review-later-x1.');
  });

  it('outcome prose mentioning a label is stamped cleanly', () => {
    const r = applyLabelSuffix([{ id: 'a', emits: ['ready-to-merge'], promptTemplate: 'PR labelled ready-to-merge: done.' }], [], S);
    assert.equal(r.members[0].promptTemplate, 'PR labelled ready-to-merge-x1: done.');
  });
});

describe('idempotency (AC5)', () => {
  it('stamping twice equals stamping once — ports, prompt text and claims', () => {
    const members = [
      { id: 'a', emits: ['foo', 'foo-abc'], promptTemplate: 'Apply `foo` or foo-abc.' },
      { id: 'b', triggers: [labelTrigger('foo-abc', {
        claim: { remove: 'foo-abc', add: 'foo-abc:wip' }, promptTemplate: 'Woken by foo-abc.',
      })] },
    ];
    const humans = [{ id: 'po', name: 'PO', emits: ['foo'], consumes: [{ label: 'foo-abc' }] }];
    const once = applyLabelSuffix(members, [{ name: 'foo' }], S, humans);
    const twice = applyLabelSuffix(once.members, once.bundleLabels, S, once.humans);
    assert.deepEqual(twice.members, once.members);
    assert.deepEqual(twice.bundleLabels, once.bundleLabels);
    assert.deepEqual(twice.humans, once.humans);
  });
});

describe('humans registry (AC6)', () => {
  it('stamps emits and consumes[].label, leaves role/artifact/file consumes alone', () => {
    const humans = [{
      id: 'po', name: 'Product Owner',
      emits: ['ready', 'spec-approved'],
      consumes: [
        { label: 'spec-ready-for-review' },
        { artifact: 'pr', from: 'team-dev' },
        { artifact: 'file', name: 'spec' },
      ],
    }];
    const out = applyLabelSuffix([{ id: 'dev', emits: ['spec-ready-for-review'] }], [{ name: 'ready', humanGate: true }], S, humans);
    assert.deepEqual(out.humans, [{
      id: 'po', name: 'Product Owner',
      emits: ['ready-x1', 'spec-approved-x1'],
      consumes: [
        { label: 'spec-ready-for-review-x1' },
        { artifact: 'pr', from: 'team-dev' },
        { artifact: 'file', name: 'spec' },
      ],
    }]);
    assert.ok(out.tokenSet.has('spec-approved-x1'), 'a human-only label is provisioned too');
  });

  it('a human consume meets the agent emit after stamping (AC7)', () => {
    const humans = [{ id: 'po', name: 'PO', consumes: [{ label: 'spec-ready-for-review' }] }];
    const out = applyLabelSuffix([{ id: 'dev', emits: ['spec-ready-for-review'] }], [], S, humans);
    assert.equal(out.humans[0].consumes[0].label, out.members[0].emits[0]);
  });
});

describe('no suffix — unchanged output (AC9)', () => {
  it('returns the very same members, labels and humans', () => {
    const members = [{ id: 'a', triggers: [labelTrigger('ready', { claim: { remove: 'ready', add: 'ready:wip' } })] }];
    const labels = [{ name: 'ready' }];
    const humans = [{ id: 'po', name: 'PO', emits: ['ready'] }];
    const out = applyLabelSuffix(members, labels, '', humans);
    assert.equal(out.members, members);
    assert.equal(out.bundleLabels, labels);
    assert.equal(out.humans, humans);
  });

  it('stampLiveLabels is the identity without a suffix', () => {
    const body = { outcomes: { mode: 'anyOf', options: [{ id: 'x', actions: [{ type: 'setLabel', label: 'foo' }] }] } };
    assert.equal(stampLiveLabels(body, ''), body);
    assert.equal(stampLiveLabels(body, undefined), body);
    const trig = labelTrigger('ready');
    assert.equal(stampLiveLabels(trig, '', { trigger: true }), trig);
  });
});

describe('bare one-word labels in prompts (AC10)', () => {
  it('still left unchanged with a warning; backtick-quoted ones still stamped', () => {
    const bare = applyLabelSuffix([{ id: 'a', emits: ['ready'], promptTemplate: 'Apply ready when done.' }], [], S);
    assert.equal(bare.members[0].promptTemplate, 'Apply ready when done.');
    assert.equal(bare.warnings.length, 1);
    assert.match(bare.warnings[0], /'ready'/);
    const quoted = applyLabelSuffix([{ id: 'a', emits: ['ready'], promptTemplate: 'Apply `ready` when done.' }], [], S);
    assert.equal(quoted.members[0].promptTemplate, 'Apply `ready-x1` when done.');
  });
});

describe('live-team edits (AC8)', () => {
  it('stamps an agent PUT body: outcome setLabel, channel label, legacy emits', () => {
    const body = {
      outcomes: { mode: 'anyOf', options: [
        { id: 'done', actions: [{ type: 'setLabel', label: 'needs-review' }, { type: 'wakeAgent', to: 'team-qa' }] },
      ] },
      channels: [{ artifact: 'pr', from: 'team-dev', label: 'ready-for-qa' }],
      emits: ['handed-over'],
      displayName: 'QA',
    };
    const out = stampLiveLabels(body, S);
    assert.equal(out.outcomes.options[0].actions[0].label, 'needs-review-x1');
    assert.deepEqual(out.outcomes.options[0].actions[1], { type: 'wakeAgent', to: 'team-qa' });
    assert.equal(out.channels[0].label, 'ready-for-qa-x1');
    assert.equal(out.channels[0].from, 'team-dev');
    assert.deepEqual(out.emits, ['handed-over-x1']);
    assert.equal(out.displayName, 'QA');
  });

  it('stamps a team PUT body: label registry and human gate/emits/consumes', () => {
    const body = {
      labels: [{ name: 'ready-x1', humanGate: true }, { name: 'approved', humanGate: true }],
      humans: [{ id: 'po', name: 'PO', emits: ['approved'], consumes: [{ label: 'ready-x1' }, { artifact: 'pr', from: 'team-dev' }] }],
    };
    const out = stampLiveLabels(body, S);
    assert.deepEqual(out.labels, [{ name: 'ready-x1', humanGate: true }, { name: 'approved-x1', humanGate: true }]);
    assert.deepEqual(out.humans[0].emits, ['approved-x1']);
    assert.deepEqual(out.humans[0].consumes, [{ label: 'ready-x1' }, { artifact: 'pr', from: 'team-dev' }]);
  });

  it('stamps a trigger: labelFilter, claim and the label in its prompt', () => {
    const t = {
      type: 'github-event', events: ['issues.labeled'], labelFilter: 'approved', enabled: true,
      claim: { remove: 'approved', add: 'approved:wip' },
      prompt: 'A human applied `approved` — proceed.',
    };
    const out = stampLiveLabels(t, S, { trigger: true });
    assert.equal(out.labelFilter, 'approved-x1');
    assert.deepEqual(out.claim, { remove: 'approved-x1', add: 'approved-x1:wip' });
    assert.equal(out.prompt, 'A human applied `approved-x1` — proceed.');
    assert.deepEqual(out.events, ['issues.labeled']);
  });

  it('stamps a member create body (triggers + ports)', () => {
    const body = {
      id: 'team-qa', displayName: 'QA', systemPromptOverride: 'Test it.',
      triggers: [{ type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-qa', prompt: 'Run QA on ready-for-qa.' }],
    };
    const out = stampLiveLabels(body, S);
    assert.equal(out.triggers[0].labelFilter, 'ready-for-qa-x1');
    assert.equal(out.triggers[0].prompt, 'Run QA on ready-for-qa-x1.');
    assert.equal(out.systemPromptOverride, 'Test it.');
  });

  it('a name already ending in -<suffix> is not stamped again', () => {
    const out = stampLiveLabels({ channels: [{ artifact: 'issue', from: 'team-ba', label: 'ready-x1' }] }, S);
    assert.equal(out.channels[0].label, 'ready-x1');
    const t = stampLiveLabels({ labelFilter: 'ready-x1', claim: { remove: 'ready-x1', add: 'ready-x1:wip' } }, S, { trigger: true });
    assert.equal(t.labelFilter, 'ready-x1');
    assert.deepEqual(t.claim, { remove: 'ready-x1', add: 'ready-x1:wip' });
  });

  it('works with a hyphen-bearing team suffix', () => {
    const out = stampLiveLabels({ labels: [{ name: 'ready' }, { name: 'ready-team-1' }] }, 'team-1');
    assert.deepEqual(out.labels, [{ name: 'ready-team-1' }, { name: 'ready-team-1' }]);
  });

  it('ignores a malformed body or suffix', () => {
    assert.equal(stampLiveLabels(null, S), null);
    const body = { labels: [{ name: 'a-b' }] };
    assert.equal(stampLiveLabels(body, 'Bad--'), body);
  });
});

describe('real-world style bundle (AC11)', () => {
  it('no unsuffixed label token is left in any saved field', () => {
    const bundle = {
      processTemplateVersion: 1,
      labels: [{ name: 'ready', humanGate: true }, { name: 'spec-ready-for-review-jvc' }],
      roles: [
        {
          id: 'ba', displayName: 'Business Analyst', github: { producesIssue: true },
          systemPrompt: 'Refine the issue. When done apply `spec-ready-for-review`.',
          outputs: [{ name: 'Spec', path: 'specs/spec.md' }],
          outcomes: { mode: 'anyOf', options: [
            { id: 'spec-ready', title: 'Spec ready', actions: [{ type: 'setLabel', label: 'spec-ready-for-review' }] },
          ] },
          triggers: [{ id: 'gate', type: 'github-event', events: ['issues.labeled'], labelFilter: 'spec-required',
            claim: { remove: 'spec-required', add: 'spec-required:wip', postcondition: 'pr-opened' },
            promptTemplate: 'An issue was labelled spec-required. Old leftover: spec-ready-for-review-jvc.' }],
        },
        {
          id: 'dev', displayName: 'Developer', github: { producesPr: true },
          systemPrompt: 'Implement. Then label the PR `ready-for-qa`.',
          inputs: [{ name: 'Spec' }],
          channels: [
            { artifact: 'issue', from: 'ba', label: 'spec-ready-for-review' },
            { artifact: 'issue', from: 'ba', label: 'ready', gate: 'human' },
          ],
          outcomes: { mode: 'anyOf', options: [
            { id: 'pr', title: 'PR opened', actions: [{ type: 'setLabel', label: 'ready-for-qa' }] },
          ] },
        },
        {
          id: 'qa', displayName: 'QA',
          systemPrompt: 'Test the PR.',
          channels: [{ artifact: 'pr', from: 'dev', label: 'ready-for-qa' }],
        },
      ],
      humans: [{
        id: 'po', name: 'Product Owner',
        emits: ['ready'],
        consumes: [{ label: 'spec-ready-for-review' }, { artifact: 'pr', from: 'dev' }],
      }],
    };
    const members = materialise(bundle);
    const humans = remapHumanConsumesFrom(normalizeHumans(bundle.humans), (f) => `team-${f}`);
    const out = applyLabelSuffix(members, bundle.labels, S, humans);

    const original = ['ready', 'spec-required', 'spec-ready-for-review', 'spec-ready-for-review-jvc', 'ready-for-qa'];
    const bare = new RegExp(`(?<![\\w-])(${original.map(l => l.replace(/-/g, '\\-')).join('|')})(?!-?\\w)`);
    for (const [at, v] of strings({ members: out.members, labels: out.bundleLabels, humans: out.humans })) {
      // Bare one-word mentions are out of scope (AC10) — only the port/claim
      // fields and multi-word prompt mentions are asserted here.
      if (/prompt/i.test(at)) {
        const m = v.match(bare);
        if (m) assert.equal(m[1], 'ready', `unstamped '${m[1]}' at ${at}: ${v}`);
      } else if (/(labelFilter|\.label|emits\[\d+\]|^\$\.labels\[\d+\]\.name|claim\.(remove|add))$/.test(at)) {
        assert.match(v, /-x1(:wip)?$/, `unstamped ${at}: ${v}`);
      }
      assert.doesNotMatch(v, /x1-[\w-]*-x1|-x1-x1/, `double-stamped ${at}: ${v}`);
    }
    // Claims line up with their labelFilters (AC1/AC2/AC3).
    for (const m of out.members) {
      for (const t of m.triggers || []) {
        if (t.claim) assert.equal(t.claim.remove, t.labelFilter, `${m.id}/${t.id}`);
      }
    }
    // The authored postcondition survived.
    const gate = out.members.find(m => m.id === 'ba').triggers.find(t => t.id === 'gate');
    assert.equal(gate.claim.postcondition, 'pr-opened');
  });
});
