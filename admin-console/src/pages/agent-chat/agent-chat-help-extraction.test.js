import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AGENT_CHAT_HELP_SECTIONS } from './agent-chat-help-sections.js';
import { topicSections, sectionSlug } from '../../context/page-help-view.js';

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

// #1972 widened this guard: the topic now covers *every* surface of the page and
// each surface carries a "?" that deep-links to its chapter. The sources below
// are the remaining mount points; the topic file itself is read so the chapter
// slugs a call site names can be checked against the headings that exist.
const rail = sourceOf('../AgentChat.jsx');
const railMenu = sourceOf('rail-lifecycle.js');
const railHost = sourceOf('RailLifecycleHost.jsx');
const composer = sourceOf('MessageInput.jsx');
const settings = sourceOf('AgentSettingsPanel.jsx');
const workspace = sourceOf('WorkspaceBrowser.jsx');
const sessions = sourceOf('SessionsPanel.jsx');
const share = sourceOf('ShareTeamPanel.jsx');
const topicBody = readFileSync(
  join(here, '../../../api/helper-chat/help-topics/agent-chat.md'), 'utf8',
);

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

// ─── #1972: every surface has a "?", and every "?" has a chapter ─────────────
//
// The topic is now a full reference, so the two halves that can rot are: a
// chapter heading reworded out from under the slug a call site names, and a
// surface losing its affordance. Both are asserted here rather than eyeballed,
// because a "?" that silently opens the top of a 400-line topic still *looks*
// like it works.

test('every chapter slug a call site names is really a heading in the topic', () => {
  const known = new Set(topicSections(topicBody).map(s => s.slug));
  const missing = Object.entries(AGENT_CHAT_HELP_SECTIONS)
    .filter(([, slug]) => !known.has(slug))
    .map(([name, slug]) => `${name} → "${slug}"`);
  assert.deepEqual(
    missing, [],
    'help-topics/agent-chat.md no longer has a heading for these chapters. '
    + 'Reword the heading back, or update AGENT_CHAT_HELP_SECTIONS — a stale '
    + 'slug degrades silently to "open the topic at the top". '
    + `Known headings: ${[...known].join(', ')}`,
  );
});

test('the chapter slugs are derived from the headings, not hand-written', () => {
  // Guards the pairing itself: if sectionSlug ever changed, the constants would
  // still "exist" as strings while matching nothing at runtime.
  assert.equal(sectionSlug('The agent list'), AGENT_CHAT_HELP_SECTIONS.agentList);
  assert.equal(
    sectionSlug('Triggers — when the agent wakes on its own'),
    AGENT_CHAT_HELP_SECTIONS.triggers,
  );
});

test('the topic keeps one clearly-headed chapter per area of the page', () => {
  const h2 = topicSections(topicBody).filter(s => s.level === 2).map(s => s.slug);
  for (const slug of [
    AGENT_CHAT_HELP_SECTIONS.page,
    AGENT_CHAT_HELP_SECTIONS.agentList,
    AGENT_CHAT_HELP_SECTIONS.header,
    AGENT_CHAT_HELP_SECTIONS.composer,
    AGENT_CHAT_HELP_SECTIONS.rightRail,
    AGENT_CHAT_HELP_SECTIONS.triggers,
    AGENT_CHAT_HELP_SECTIONS.outcomes,
    AGENT_CHAT_HELP_SECTIONS.knowledge,
    AGENT_CHAT_HELP_SECTIONS.settings,
    AGENT_CHAT_HELP_SECTIONS.shareTeam,
  ]) {
    assert.ok(h2.includes(slug), `"${slug}" must stay a top-level chapter, not a sub-heading`);
  }
});

test('each Agent Chat surface mounts a "?" pointed at its own chapter', () => {
  const wired = [
    ['the left-rail header', rail, 'agentList'],
    ['the chat header controls', chat, 'header'],
    ['the loop launcher', chat, 'loops'],
    ['the composer', composer, 'composer'],
    ['the Triggers tab', triggers, 'triggers'],
    ['the Outcomes tab', outcomes, 'outcomes'],
    ['the Knowledge tab', knowledge, 'knowledge'],
    ['the Settings tab', settings, 'settings'],
    ['the Workspace tab', workspace, 'workspace'],
    ['the Sessions tab', sessions, 'sessions'],
    ['the session log', sessions, 'sessionLog'],
    ['the team Share panel', share, 'shareTeam'],
  ];
  for (const [what, source, key] of wired) {
    assert.ok(
      source.includes('PageHelpButton'),
      `${what} must render the shared PageHelpButton`,
    );
    assert.ok(
      source.includes(`AGENT_CHAT_HELP_SECTIONS.${key}`),
      `${what} must deep-link to the ${key} chapter (never a hand-written slug)`,
    );
  }
});

test('the row context menu carries help as an entry, not a nested button', () => {
  // RowContextMenu walks its items by index for keyboard traversal, so the
  // affordance has to be a real entry; a PageHelpButton inside a menu item
  // would also be a button inside a button.
  assert.ok(
    /export function helpMenuItem/.test(railMenu),
    'rail-lifecycle.js must own the chat-only help entry, like markUnreadItem',
  );
  assert.ok(
    /separated: true/.test(railMenu),
    'the help entry is fenced off from the actions above it',
  );
  assert.ok(
    /kind === 'help'/.test(railHost) && /AGENT_CHAT_HELP_SECTIONS\.agentList/.test(railHost),
    'RailLifecycleHost must open the panel at the agent-list chapter for that entry',
  );
  assert.ok(
    !/helpMenuItem/.test(sourceOf('../agent-lifecycle/agent-lifecycle-menu.js')),
    'the shared descriptor the Agents page renders must stay free of the chat-only entry',
  );
});

test('the point-of-decision microcopy the epic protects is still on the page', () => {
  // #1972 explicitly must NOT strip live hints while expanding the topic.
  assert.ok(/each run starts\s+fresh/.test(chat), 'loop launcher stop-contract lead');
  assert.ok(
    /This agent signals nothing when a run ends, so no teammate is woken/.test(outcomes),
    'Outcomes empty-state pointer',
  );
  assert.ok(
    /You can un-retire it on the Knowledge page\./.test(knowledge),
    'retire-dialog reversibility sentence',
  );
});
