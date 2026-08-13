import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Drift guard (no pure module — these confirm flows are inline component state,
// per the agent-chat "logic lives inline, no unit tests" convention). Locks in
// the usability consistency fix: the three remaining destructive/irreversible
// actions in Agent Chat (prompt revert, retire learning, resume-over-active-
// session) must confirm through the shared styled ConfirmDialog like every
// other console confirmation, NOT the native window.confirm (jarring, unstyled,
// inconsistent, un-themeable).
const read = (name) => readFileSync(
  fileURLToPath(new URL(`./${name}`, import.meta.url)),
  'utf8',
);

const FILES = ['PromptHistory.jsx', 'AgentKnowledgePanel.jsx', 'SessionsPanel.jsx'];

for (const name of FILES) {
  const src = read(name);

  test(`${name} adopts the shared ConfirmDialog`, () => {
    assert.match(src, /import ConfirmDialog from '\.\.\/\.\.\/components\/ConfirmDialog'/);
    assert.match(src, /<ConfirmDialog\b/);
  });

  test(`${name} does not fall back to a native window.confirm`, () => {
    assert.doesNotMatch(src, /window\.confirm/);
  });
}
