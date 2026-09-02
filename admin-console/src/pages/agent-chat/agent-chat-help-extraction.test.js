import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── E15 (#1889, epic #1870) extraction drift guard ──────────────────────────
//
// The Agent Chat side panels' conceptual prose — the trigger-type banners, what a
// structured outcome is, and why retiring a learning is safe — is now the
// single-sourced help topic (api/helper-chat/help-topics/agent-chat.md, guarded
// for content by help-topics-content.test.js). This test reads the four page
// sources and asserts the *page side* of that move: the prose did not quietly
// grow back, and the affordances that replaced it are still wired.
//
// The JSX is otherwise uncovered per the #651 convention — this is a source-text
// guard, not a render test.

const here = dirname(fileURLToPath(import.meta.url));

// Comments must be stripped before asserting on the copy: this extraction's own
// explanatory comments name what moved to the topic ("the four terminal states",
// "the git audit trail"), and would otherwise false-positive the very guard they
// belong to. Closing `*/` inside a string is not a concern in these files.
function sourceOf(file) {
  return readFileSync(join(here, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const triggers = sourceOf('TriggersPanel.jsx');
const chat = sourceOf('ChatPanel.jsx');
const outcomes = sourceOf('OutcomesPanel.jsx');
const knowledge = sourceOf('AgentKnowledgePanel.jsx');

test('the loop type banner is a one-liner, not the old paragraph', () => {
  assert.ok(
    /A <strong>loop<\/strong> re-runs this agent until the work is done/.test(triggers),
    'the loop banner must keep its one-line plain-language lead (#1083 AC5)',
  );
  for (const phrase of [
    'feeding each run',
    'maximum number of tries you set',
    'tasks that take several passes',
    'working through a checklist',
  ]) {
    assert.ok(
      !triggers.includes(phrase),
      `"${phrase}" belongs to help-topics/agent-chat.md, not to the trigger form`,
    );
  }
});

test('the data-flow banner keeps the surprising fact and drops the authoring advice', () => {
  assert.ok(
    /Woken by <strong>any push<\/strong> to the team repo/.test(triggers),
    'the one-liner must still say a data-flow trigger fires on any push',
  );
  assert.ok(
    /including this\s+agent's own/.test(triggers),
    'that it fires for the agent\'s own pushes is the non-obvious half — it stays',
  );
  for (const phrase of [
    "teammate's committed work is the hand-off",
    'check whether the change is relevant',
    "if there's nothing to do",
  ]) {
    assert.ok(
      !triggers.includes(phrase),
      `"${phrase}" belongs to help-topics/agent-chat.md, not to the trigger form`,
    );
  }
});

test('the flow-verifier option keeps one line, its rationale moved', () => {
  assert.ok(
    /No inline check between tries/.test(triggers),
    'the selected option still needs a one-line explanation',
  );
  assert.ok(
    !triggers.includes('the same reviewer would check the work twice'),
    'why you would pick this mode is the topic\'s job',
  );
});

test('the Triggers panel toolbar carries the shared "?" affordance', () => {
  assert.ok(
    /import PageHelpButton from '\.\.\/\.\.\/components\/PageHelpButton'/.test(triggers),
    'TriggersPanel must import the shared PageHelpButton',
  );
  assert.ok(
    /<PageHelpButton\s+label="What the trigger types do"/.test(triggers),
    'the toolbar "?" must be present — it is what replaced the banners',
  );
});

test('the chat header carries the page\'s "?" affordance', () => {
  assert.ok(
    /import PageHelpButton from '\.\.\/\.\.\/components\/PageHelpButton'/.test(chat),
    'ChatPanel must import the shared PageHelpButton',
  );
  assert.ok(
    /<PageHelpButton label="Help for Agent Chat"/.test(chat),
    'the bespoke chat header keeps the page-level "?" (the #1847 exception)',
  );
});

test('the loop launcher keeps what it does and how it stops, plus a "?"', () => {
  // Same rule as copy above a required input: a loop is a consequential launch,
  // so the stop contract stays at the point of decision (#1120).
  assert.ok(
    /each run starts\s+fresh/.test(chat),
    'the launcher must still say each run starts fresh',
  );
  assert.ok(
    /<strong>max iterations<\/strong> cap is hit/.test(chat),
    'the launcher must still name the stop conditions',
  );
  assert.ok(
    /<PageHelpButton\n\s+label="How loops work"/.test(chat),
    'the launcher needs its own contextual "?" now that the concept prose is gone',
  );
});

test('the outcomes legacy hint keeps the pointer, not the definition', () => {
  assert.ok(
    /Structured outcomes can\s+be authored in the Flow Editor/.test(outcomes),
    'the actionable "authored in the Flow Editor" pointer stays',
  );
  assert.ok(
    !outcomes.includes('with a condition and a title per outcome'),
    'what a structured outcome is belongs to help-topics/agent-chat.md',
  );
});

test('the outcomes empty state keeps its actionable pointer verbatim', () => {
  // AC2 explicitly protects this one: an agent that signals nothing is a wiring
  // gap, and the empty state is where a user finds that out.
  assert.ok(
    /This agent signals nothing when a run ends, so no teammate is woken/.test(outcomes),
    'the empty-state explainer must not be extracted',
  );
  assert.ok(
    /Outcomes are authored in the Flow Editor\./.test(outcomes),
    'the empty state keeps its jump-off to where editing happens',
  );
});

test('the retire dialog keeps the reversibility and drops the rationale', () => {
  assert.ok(
    /You can un-retire it on the Knowledge page\./.test(knowledge),
    'the confirm needs to say the action is reversible',
  );
  assert.ok(
    !knowledge.includes('It stays in git for audit'),
    'the git-audit rationale belongs to help-topics/agent-chat.md',
  );
});
