import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultListenerPrompt,
  handoffVerb,
  handoffTargetNoun,
} from './handoff-prompt.js';

test('handoffVerb maps the label action to a phrase', () => {
  assert.equal(handoffVerb('labeled'), 'added to');
  assert.equal(handoffVerb('unlabeled'), 'removed from');
});

test('handoffTargetNoun maps the label target to a noun', () => {
  assert.equal(handoffTargetNoun('issues'), 'an issue');
  assert.equal(handoffTargetNoun('pull_request'), 'a pull request');
});

test('defaultListenerPrompt renders the full wake-up instruction', () => {
  const p = defaultListenerPrompt({
    label: 'ready', verb: 'added to', targetNoun: 'an issue',
    repo: 'acme/widgets', fromLabel: 'Dispatcher', toLabel: 'Developer',
  });
  assert.equal(
    p,
    '`ready` was added to an issue in `acme/widgets` by Dispatcher. ' +
    'The event payload above has the details.\n\n' +
    '<Describe what Developer should do.> Reply `[PASS]` if there\'s nothing to do.',
  );
});

test('defaultListenerPrompt substitutes placeholders for missing label/repo', () => {
  const p = defaultListenerPrompt({
    label: '', verb: 'removed from', targetNoun: 'a pull request',
    repo: '', fromLabel: 'A', toLabel: 'B',
  });
  assert.match(p, /^`<label>` was removed from a pull request by A\./);
  // #2665: nothing ever substitutes a `<repo>` stand-in — the clause is omitted.
  assert.doesNotMatch(p, /<repo>|\bin `/);
  assert.match(p, /<Describe what B should do\.>/);
});

// The create dialog and the edit dialog (#822) must produce byte-identical
// defaults for the same hand-off — this is what makes AC3's "same default"
// guarantee hold and AC8's "no change to create output" true.
test('defaultListenerPrompt is deterministic for identical inputs', () => {
  const args = {
    label: 'stage:td', verb: 'added to', targetNoun: 'an issue',
    repo: 'o/r', fromLabel: 'BA', toLabel: 'Dev',
  };
  assert.equal(defaultListenerPrompt(args), defaultListenerPrompt({ ...args }));
});
