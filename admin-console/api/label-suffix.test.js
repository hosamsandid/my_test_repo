'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SUFFIX_RE,
  validateSuffix,
  suggestSuffix,
  collectLabelTokens,
  applyLabelSuffix,
} = require('./label-suffix');

// ─── validateSuffix ───────────────────────────────────────────────────────────
describe('validateSuffix', () => {
  it('accepts empty / absent suffix', () => {
    assert.deepEqual(validateSuffix(''), { ok: true });
    assert.deepEqual(validateSuffix(undefined), { ok: true });
    assert.deepEqual(validateSuffix(null), { ok: true });
  });

  it('accepts valid 1-8 char base36 strings', () => {
    assert.deepEqual(validateSuffix('k3f9'), { ok: true });
    assert.deepEqual(validateSuffix('a'), { ok: true });
    assert.deepEqual(validateSuffix('abcd1234'), { ok: true });
  });

  it('rejects uppercase', () => {
    assert.equal(validateSuffix('K3F9').ok, false);
  });

  // #1934 AC4/AC5 — hyphens are legal in GitHub label names, so a readable
  // suffix is allowed; only a hyphen that would produce `ready--x` / `ready-x-`
  // is refused.
  it('accepts single inner dashes', () => {
    assert.deepEqual(validateSuffix('team-1'), { ok: true });
    assert.deepEqual(validateSuffix('stack-a'), { ok: true });
    assert.deepEqual(validateSuffix('pre-prod'), { ok: true });
    assert.deepEqual(validateSuffix('a-b-c-d'), { ok: true });
  });

  it('rejects leading, trailing and doubled dashes', () => {
    for (const bad of ['-x', 'x-', 'a--b', '-', '--']) {
      assert.equal(validateSuffix(bad).ok, false, `'${bad}' should be rejected`);
    }
  });

  it('names the dash rule in the error', () => {
    assert.match(validateSuffix('x-').error, /hyphen/i);
  });

  it('rejects longer than 8, dashes included', () => {
    assert.equal(validateSuffix('abcdefghi').ok, false);
    assert.equal(validateSuffix('stack-alpha').ok, false);
  });

  it('rejects non-string', () => {
    assert.equal(validateSuffix(42).ok, false);
  });
});

// ─── suggestSuffix ────────────────────────────────────────────────────────────
describe('suggestSuffix', () => {
  it('returns a 4-char base36 string', () => {
    for (let i = 0; i < 10; i++) {
      const s = suggestSuffix();
      assert.match(s, SUFFIX_RE);
      assert.equal(s.length, 4);
    }
  });
});

// ─── collectLabelTokens ───────────────────────────────────────────────────────
describe('collectLabelTokens', () => {
  it('collects from emits', () => {
    const members = [{ emits: ['ready-for-review', 'revisions-required'] }];
    const tokens = collectLabelTokens(members);
    assert.ok(tokens.has('ready-for-review'));
    assert.ok(tokens.has('revisions-required'));
  });

  it('collects from trigger labelFilter', () => {
    const members = [{ triggers: [{ labelFilter: 'ready-for-implementation' }] }];
    const tokens = collectLabelTokens(members);
    assert.ok(tokens.has('ready-for-implementation'));
  });

  it('collects from channel label', () => {
    const members = [{ channels: [{ artifact: 'pr', from: 'developer', label: 'ready-for-review' }] }];
    const tokens = collectLabelTokens(members);
    assert.ok(tokens.has('ready-for-review'));
  });

  it('collects from outcome setLabel actions', () => {
    const members = [{
      outcomes: {
        options: [{ actions: [{ type: 'setLabel', label: 'ready-for-review' }] }],
      },
    }];
    const tokens = collectLabelTokens(members);
    assert.ok(tokens.has('ready-for-review'));
  });

  it('collects from bundleLabels', () => {
    const bundleLabels = [{ name: 'needs-refinement', humanGate: false, brake: false }];
    const tokens = collectLabelTokens([], bundleLabels);
    assert.ok(tokens.has('needs-refinement'));
  });

  it('ignores non-string/empty values', () => {
    const members = [{ emits: [null, '', 'real-label'] }];
    const tokens = collectLabelTokens(members);
    assert.equal(tokens.size, 1);
    assert.ok(tokens.has('real-label'));
  });
});

// ─── applyLabelSuffix ─────────────────────────────────────────────────────────
describe('applyLabelSuffix', () => {
  // Basic no-op (empty suffix)
  it('no-op when suffix is empty', () => {
    const members = [{ emits: ['ready-for-review'], triggers: [], channels: [] }];
    const bundleLabels = [{ name: 'ready-for-review' }];
    const result = applyLabelSuffix(members, bundleLabels, '');
    assert.deepEqual(result.members, members);
    assert.deepEqual(result.bundleLabels, bundleLabels);
    assert.equal(result.warnings.length, 0);
  });

  // Port surfaces: emits
  it('stamps emits', () => {
    const members = [{ emits: ['ready-for-review', 'revisions-required'] }];
    const { members: out } = applyLabelSuffix(members, [], 'ab12');
    assert.deepEqual(out[0].emits, ['ready-for-review-ab12', 'revisions-required-ab12']);
  });

  // Port surfaces: trigger labelFilter
  it('stamps trigger labelFilter', () => {
    const members = [{ triggers: [{ id: 't1', labelFilter: 'ready-for-implementation' }] }];
    const { members: out } = applyLabelSuffix(members, [], 'ab12');
    assert.equal(out[0].triggers[0].labelFilter, 'ready-for-implementation-ab12');
  });

  // Port surfaces: channel label
  it('stamps channel label', () => {
    const members = [{ channels: [{ artifact: 'pr', from: 'dev', label: 'ready-for-review' }] }];
    const { members: out } = applyLabelSuffix(members, [], 'ab12');
    assert.equal(out[0].channels[0].label, 'ready-for-review-ab12');
  });

  // Port surfaces: outcome setLabel
  it('stamps outcome setLabel action', () => {
    const members = [{
      outcomes: {
        options: [{ actions: [{ type: 'setLabel', label: 'ready-for-review' }] }],
      },
    }];
    const { members: out } = applyLabelSuffix(members, [], 'ab12');
    assert.equal(out[0].outcomes.options[0].actions[0].label, 'ready-for-review-ab12');
  });

  // #2030 non-regression: a wakeAgent's `to` is a ROLE ID, not a label token.
  // Stamping it would rewrite the target of every direct hand-off in a
  // suffixed team into an agent id that does not exist — the hand-off would
  // then fail with `404 unknown-target` at delivery, long after the team was
  // created and with nothing on GitHub to point at the cause.
  it('does NOT stamp a wakeAgent to (it is a role id, not a label)', () => {
    const members = [{
      outcomes: {
        options: [{ actions: [
          { type: 'setLabel', label: 'ready-for-review' },
          { type: 'wakeAgent', to: 'code-reviewer', note: 'Check `ready-for-review` first.' },
        ] }],
      },
    }];
    const { members: out } = applyLabelSuffix(members, [], 'ab12');
    const [setLabel, wake] = out[0].outcomes.options[0].actions;
    assert.equal(setLabel.label, 'ready-for-review-ab12', 'the setLabel arm is unchanged');
    assert.equal(wake.to, 'code-reviewer');
    assert.equal(wake.type, 'wakeAgent');
  });

  // A role id that happens to LOOK like a label token is still not stamped —
  // the discriminator is the action type, never the string's shape.
  it('does NOT stamp a wakeAgent to even when it collides with a label name', () => {
    const members = [{
      outcomes: { options: [{ actions: [{ type: 'wakeAgent', to: 'ready-for-review' }] }] },
    }];
    const bundleLabels = [{ name: 'ready-for-review' }];
    const { members: out, bundleLabels: outLabels } = applyLabelSuffix(members, bundleLabels, 'ab12');
    assert.equal(out[0].outcomes.options[0].actions[0].to, 'ready-for-review');
    assert.equal(outLabels[0].name, 'ready-for-review-ab12');
  });

  // collectLabelTokens feeds the stamper AND the prompt-coverage warning, so a
  // `to` leaking into it would also make a hand-off target look like a label
  // the prompt failed to stamp.
  it('collectLabelTokens ignores a wakeAgent to', () => {
    const tokens = collectLabelTokens([{
      outcomes: { options: [{ actions: [
        { type: 'setLabel', label: 'ready-for-review' },
        { type: 'wakeAgent', to: 'code-reviewer' },
      ] }] },
    }], []);
    assert.ok(tokens.has('ready-for-review'));
    assert.equal(tokens.has('code-reviewer'), false);
  });

  // Port surfaces: bundleLabels registry
  it('stamps bundleLabels names', () => {
    const bundleLabels = [
      { name: 'ready-for-review', humanGate: false, brake: false },
      { name: 'revisions-required', humanGate: false, brake: false },
    ];
    const members = [{ emits: ['ready-for-review'] }];
    const { bundleLabels: out } = applyLabelSuffix(members, bundleLabels, 'ab12');
    assert.equal(out[0].name, 'ready-for-review-ab12');
    assert.equal(out[1].name, 'revisions-required-ab12');
  });

  // Prompt rewriting — backtick tokens always rewritten
  it('rewrites backtick-quoted tokens in promptTemplate', () => {
    const members = [{
      emits: ['ready-for-review'],
      promptTemplate: 'Apply the `ready-for-review` label when done.',
    }];
    const { members: out } = applyLabelSuffix(members, [], 'ab12');
    assert.ok(out[0].promptTemplate.includes('`ready-for-review-ab12`'));
  });

  // Prompt rewriting — bare dash-token rewritten
  it('rewrites bare dash-containing tokens in promptTemplate', () => {
    const members = [{
      emits: ['ready-for-review'],
      promptTemplate: 'Set the ready-for-review label.',
    }];
    const { members: out } = applyLabelSuffix(members, [], 'ab12');
    assert.ok(out[0].promptTemplate.includes('ready-for-review-ab12'));
  });

  // Prompt rewriting — bare no-dash token NOT rewritten, coverage warning
  it('does not rewrite bare no-dash tokens and emits coverage warning', () => {
    const members = [{
      emits: ['ready'],
      triggers: [{ id: 't1', labelFilter: 'ready', promptTemplate: 'apply ready label' }],
    }];
    const { members: out, warnings } = applyLabelSuffix(members, [], 'ab12');
    // trigger labelFilter stamped
    assert.equal(out[0].triggers[0].labelFilter, 'ready-ab12');
    // bare word in prompt not stamped
    assert.ok(out[0].triggers[0].promptTemplate.includes('apply ready label'));
    // but a warning was emitted
    assert.ok(warnings.some(w => w.includes("'ready'")));
  });

  // Prompt rewriting — backtick no-dash token IS rewritten
  it('rewrites backtick-quoted no-dash tokens', () => {
    const members = [{
      emits: ['ready'],
      promptTemplate: 'Apply `ready` label.',
    }];
    const { members: out, warnings } = applyLabelSuffix(members, [], 'ab12');
    assert.ok(out[0].promptTemplate.includes('`ready-ab12`'));
    // no warning since the token was backtick-quoted
    assert.equal(warnings.length, 0);
  });

  // Trigger promptTemplate rewriting
  it('rewrites trigger promptTemplate', () => {
    const members = [{
      emits: ['ready-for-review'],
      triggers: [{
        id: 't1',
        labelFilter: 'ready-for-review',
        promptTemplate: 'Set `ready-for-review` when done.',
      }],
    }];
    const { members: out } = applyLabelSuffix(members, [], 'ab12');
    assert.ok(out[0].triggers[0].promptTemplate.includes('`ready-for-review-ab12`'));
  });

  // Idempotency guard
  it('does not double-stamp already-stamped tokens', () => {
    const members = [{ emits: ['ready-for-review-ab12'] }];
    const { members: out } = applyLabelSuffix(members, [], 'ab12');
    assert.deepEqual(out[0].emits, ['ready-for-review-ab12']);
  });

  // Longest-token-first prevents partial collisions
  it('longest-first matching prevents shorter token matching inside longer one', () => {
    // Both 'ready' and 'ready-for-review' are tokens
    const members = [{
      emits: ['ready', 'ready-for-review'],
      triggers: [{ id: 't1', labelFilter: 'ready-for-review' }],
    }];
    const { members: out } = applyLabelSuffix(members, [], 'xy');
    assert.equal(out[0].triggers[0].labelFilter, 'ready-for-review-xy');
    assert.deepEqual(out[0].emits, ['ready-xy', 'ready-for-review-xy']);
  });

  // #1934 AC7 — a hyphen-bearing suffix must not break the two mechanics that
  // are written in terms of dashes: the `-<suffix>` idempotency guard and the
  // longest-first token matching.
  it('handles a hyphen-bearing suffix (idempotency + longest-first)', () => {
    const members = [{
      emits: ['ready', 'ready-for-review'],
      triggers: [
        { id: 't1', labelFilter: 'ready' },
        { id: 't2', labelFilter: 'ready-for-review', promptTemplate: 'Wait for ready-for-review, then act' },
      ],
      channels: [{ artifact: 'pr', from: 'developer', label: 'ready' }],
      promptTemplate: 'Set `ready` when done; reviewers watch ready-for-review.',
    }];
    const bundleLabels = [{ name: 'ready', humanGate: true }, { name: 'ready-for-review' }];

    const first = applyLabelSuffix(members, bundleLabels, 'team-1');
    const m = first.members[0];
    assert.deepEqual(m.emits, ['ready-team-1', 'ready-for-review-team-1']);
    assert.equal(m.triggers[0].labelFilter, 'ready-team-1');
    assert.equal(m.triggers[1].labelFilter, 'ready-for-review-team-1');
    assert.equal(m.channels[0].label, 'ready-team-1');
    // Longest-first: 'ready' must not be found inside 'ready-for-review'.
    assert.equal(m.triggers[1].promptTemplate, 'Wait for ready-for-review-team-1, then act');
    assert.equal(m.promptTemplate, 'Set `ready-team-1` when done; reviewers watch ready-for-review-team-1.');
    assert.deepEqual(first.bundleLabels.map(l => l.name), ['ready-team-1', 'ready-for-review-team-1']);
    assert.ok(first.tokenSet.has('ready-team-1'));
    assert.ok(first.tokenSet.has('ready-for-review-team-1'));

    // Idempotency guard: re-stamping the already-stamped output is a no-op —
    // `ready-team-1`.endsWith('-team-1') must be recognised even though the
    // suffix itself contains a dash.
    const second = applyLabelSuffix(first.members, first.bundleLabels, 'team-1');
    assert.deepEqual(second.members, first.members);
    assert.deepEqual(second.bundleLabels, first.bundleLabels);
  });

  // Golden test: no suffix → byte-identical output
  it('no suffix: members and bundleLabels returned unchanged', () => {
    const members = [{
      id: 'developer',
      emits: ['ready-for-review'],
      triggers: [{ labelFilter: 'ready-for-implementation', promptTemplate: 'Implement the issue' }],
      channels: [],
      promptTemplate: 'You are the developer.',
    }];
    const bundleLabels = [{ name: 'ready-for-review', humanGate: false, brake: false }];
    const { members: m2, bundleLabels: bl2 } = applyLabelSuffix(members, bundleLabels, '');
    assert.deepEqual(m2, members);
    assert.deepEqual(bl2, bundleLabels);
  });

  // tokenSet returned contains stamped tokens
  it('tokenSet contains the stamped token names', () => {
    const members = [{ emits: ['ready-for-review'] }];
    const { tokenSet } = applyLabelSuffix(members, [], 'ab12');
    assert.ok(tokenSet.has('ready-for-review-ab12'));
  });

  // warnings deduplicated
  it('deduplicates identical warnings', () => {
    const members = [
      { emits: ['ready'], triggers: [{ id: 't1', labelFilter: 'ready', promptTemplate: 'apply ready now' }] },
      { emits: ['ready'], triggers: [{ id: 't2', labelFilter: 'ready', promptTemplate: 'apply ready now' }] },
    ];
    const { warnings } = applyLabelSuffix(members, [], 'ab12');
    const readyWarnings = warnings.filter(w => w.includes("'ready'"));
    assert.equal(readyWarnings.length, 1);
  });
});

describe('requireLabel (#2822)', () => {
  it('collects and stamps a comment listener\'s required label like labelFilter', () => {
    const members = [{ id: 'spec', triggers: [{ id: 'a', type: 'github-event', events: ['issue_comment.created'], requireLabel: 'needs-answer' }] }];
    assert.ok(collectLabelTokens(members).has('needs-answer'));
    const out = applyLabelSuffix(members, [], 'x1');
    assert.equal(out.members[0].triggers[0].requireLabel, 'needs-answer-x1');
  });
});
