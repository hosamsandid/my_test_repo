import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── E14 (#1888, epic #1870) extraction drift guard ──────────────────────────
//
// The onboarding surfaces — the "+ Create" launcher, the one-assistant form, the
// Agent Team Wizard and the Agent Templates page — lost their long explanatory
// prose to three single-sourced help topics (api/helper-chat/help-topics/
// create.md, team-setup.md, role-templates.md; guarded for CONTENT by
// help-topics-content.test.js). This test reads the page sources and asserts the
// *page side* of that move: the prose has not quietly grown back, and the
// affordances that replaced it are still wired.
//
// The JSX itself stays uncovered per the #651 convention — this is a source-text
// guard, not a render test. Note `admin-console/src/` is ESM, hence the
// import/fileURLToPath header rather than require/__dirname.

const here = dirname(fileURLToPath(import.meta.url));

// Strip comments before asserting on the copy: this extraction's own explanatory
// comments name what moved to each topic, and would otherwise false-positive the
// very guard they belong to.
function source(rel) {
  return readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const create = source('Create.jsx');
const launcher = source('create-launcher-view.js');
const quickstartPage = source('QuickStart.jsx');
const quickstartView = source('quickstart-view.js');
const wizard = source('TeamSetup.jsx');
const stepProcess = source('team-setup/StepProcess.jsx');
const templates = source('RoleTemplates.jsx');

const PAGES = [
  ['Create.jsx', create],
  ['QuickStart.jsx', quickstartPage],
  ['TeamSetup.jsx', wizard],
  ['RoleTemplates.jsx', templates],
];

test('every onboarding page keeps its "?" help affordance', () => {
  for (const [name, src] of PAGES) {
    assert.match(src, /import PageHelpButton from/, `${name} must import PageHelpButton`);
    assert.match(src, /<PageHelpButton/, `${name} must render PageHelpButton`);
  }
});

test('launcher tiles are one-line intents, not paragraphs', () => {
  // Each entry states what the user wants to do; what the path produces in
  // detail is the create topic. Guard the removed elaborations by their
  // distinctive wording.
  for (const phrase of [
    'show a live preview before anything is created',
    'Fastest way to a working setup',
    'Full control',
    'No wiring',
    'the quickest path in',
  ]) {
    assert.ok(
      !launcher.includes(phrase),
      `"${phrase}" belongs to help-topics/create.md, not to a launcher entry`,
    );
  }
  // 'grow it into a' was on this banned list until #2027, whose binding copy
  // inventory puts it back on the hero verbatim ("…and grow it into a team
  // whenever you're ready"). It is not an elaboration — it is the promise that
  // starting small is not a dead end, which is exactly why the hero has to make
  // it where the choice is made. #1667 AC3 depended on the old tile's "a team of
  // one you can grow later" wording for the same reason; the phrasing moved, the
  // guarantee did not, so this asserts the new wording rather than the old.
  assert.match(
    launcher, /grow it into a team/i,
    'the hero keeps the "one assistant is not a dead end" promise on the page',
  );
  // The "team of one" *reasoning* is the topic's, and #2027 stopped the entry
  // copy from claiming the framing outright — the hero now says what you get
  // and what it grows into, which is the same promise in the user's words.
  assert.ok(
    !/team of one/i.test(launcher),
    'the "team of one" framing itself is help-topics/create.md — the entry says '
    + '"grow it into a team", which is the promise without the internal wording',
  );
});

test('the one-assistant page has one description, not two', () => {
  // QUICKSTART_COPY.detail was a second paragraph restating the intro; it is gone.
  assert.ok(
    !/\bdetail:/.test(quickstartView),
    'QUICKSTART_COPY.detail is the create topic now — the page keeps only `intro`',
  );
  for (const phrase of [
    'Creates a single chat assistant you can talk to right away',
    'leave it empty for a repo-less assistant.',
    'When you want reviewers, a developer',
  ]) {
    assert.ok(
      !quickstartView.includes(phrase),
      `"${phrase}" belongs to help-topics/create.md`,
    );
  }
  // #2045 removed the team-of-one footer card and its forward CTA: a second
  // call-to-action under the form competed with the one action the page exists
  // for. The framing is not lost — the launcher hero carries the promise (see
  // the launcher test above) and help-topics/create.md carries the reasoning —
  // so this is now a removal guard, not a keep-assertion.
  assert.ok(
    !/team of one/i.test(quickstartView),
    'the team-of-one framing is the launcher hero\'s and the create topic\'s (#2045)',
  );
  assert.ok(
    !/growCtaLabel|Grow into a full team/i.test(quickstartView),
    'the "Grow into a full team →" forward link was removed from this page (#2045)',
  );
  assert.ok(
    !/team-setup/.test(quickstartPage),
    'no link to the Agent Team Wizard may grow back under the form (#2045)',
  );
});

test('#2045: the GitHub Repository URL field carries no description', () => {
  // The `(optional)` label and the placeholder already say what an empty value
  // means; the HTTPS→SSH normalisation detail is help-topics/create.md's.
  for (const phrase of [
    'Leave empty for a repo-less assistant',
    'normalise to SSH',
    'clone with the SSH key',
  ]) {
    assert.ok(
      !quickstartPage.includes(phrase),
      `"${phrase}" was removed from the repo-URL field — it belongs to help-topics/create.md`,
    );
  }
  // What the removal must NOT touch: the label, its optional marker and the
  // placeholder are the copy that made the description redundant.
  assert.match(quickstartPage, /GitHub Repository URL/);
  assert.match(quickstartPage, /\(optional\)/);
  assert.ok(
    quickstartPage.includes('https://github.com/org/repo — leave empty for a repo-less agent'),
    'the field must keep its existing placeholder',
  );
});

test('the "What happens here" block is gone from the one-assistant page', () => {
  assert.ok(
    !/What happens here/.test(quickstartPage),
    'both branches of the "What happens here" block moved to help-topics/create.md',
  );
  for (const phrase of [
    'resolved from its remote HEAD',
    'A new repo-less Working Environment is created',
    'can be fine-tuned later under',
  ]) {
    assert.ok(
      !quickstartPage.includes(phrase),
      `"${phrase}" belongs to help-topics/create.md`,
    );
  }
});

test('the one-assistant page keeps its actionable prerequisite cards', () => {
  // Explicitly in scope to KEEP (#1888): warning cards with fix links, and the
  // checklist that explains the disabled submit button.
  for (const marker of [
    'No model provider configured',
    'No GitHub token configured',
    'No SSH key configured',
    'submitBlockers',
  ]) {
    assert.ok(quickstartPage.includes(marker), `the page must keep "${marker}"`);
  }
});

test('the wizard header is one line, and no longer re-explains Agent Team vs Team', () => {
  assert.ok(
    !/not the same as a human/.test(wizard),
    'the Agent-Team-vs-access-scope distinction lives in help-topics/team-setup.md',
  );
  assert.match(
    wizard,
    /Spin up a complete agent team/,
    'the wizard keeps its one-line description',
  );
});

test('the wizard step intros no longer restate what the wizard builds', () => {
  for (const phrase of [
    'Sets up a coordinated team of agents',
    'ready to react to issues and pull requests automatically',
    'skill pool does not exist yet',
    'Only global skills are offered here',
    'Knowledge sources are MCP servers the team can query at runtime',
    'per-member overrides come later',
  ]) {
    assert.ok(
      !wizard.includes(phrase),
      `"${phrase}" belongs to help-topics/team-setup.md`,
    );
  }
  // What remains on each step is the line that guides its own input. #2168 A2
  // reworded this from a required pick to an optional reuse (no UI path may
  // force naming or picking an environment before a team exists).
  assert.match(wizard, /Optionally reuse an existing <strong[^>]*>Environment<\/strong>/);
  assert.match(wizard, /This step is optional/);
});

test('the go-live notice stays, minus its follow-up advice', () => {
  // A consequence stated before a consequential click stays on the page (same
  // rule as the Model-Provider single-user tick and the Token-Usage cost note).
  assert.match(wizard, /What happens next/);
  assert.match(wizard, /go live immediately/);
  assert.ok(
    !/You can disable individual agents afterwards/.test(wizard),
    'staging the rollout is topic content, not a pre-click warning',
  );
});

test('the wizard keeps the label-suffix hint at the point of decision', () => {
  assert.match(wizard, /Leave this blank/, 'the label-suffix hint guides an input — it stays');
});

test('the process step keeps a bare "+ Create" pointer', () => {
  assert.match(stepProcess, /Need a custom flow\?/);
  assert.ok(
    !/can describe one or start blank in the canvas/.test(stepProcess),
    'enumerating the launcher entries is help-topics/create.md, not this hint',
  );
  // The teaching empty state is actionable and stays.
  assert.match(stepProcess, /No process templates or saved drafts are available yet/);
});

test('the Agent Templates page keeps a one-line description only', () => {
  for (const phrase of [
    'Edits create a stored override that shadows the built-in default',
    'already-created agents are independent',
    'they receive trigger-management documentation in their system prompt',
    'agents resume their last session on each trigger',
  ]) {
    assert.ok(
      !templates.includes(phrase),
      `"${phrase}" belongs to help-topics/role-templates.md`,
    );
  }
  assert.match(
    templates,
    /Reusable agent definitions the Team-Setup wizard/,
    'the page keeps its one-line description',
  );
  // The select option labels are the live choice — they stay short but present.
  assert.match(templates, /chat — always-on companion/);
  assert.match(templates, /per-invocation — each triggered run starts fresh/);
  // So does the built-in-override warning inside the edit form (point of decision).
  assert.match(templates, /This is a built-in template/);
});

test('the create launcher still hands off to all four existing routes', () => {
  for (const route of ['/flows?new=describe', '/team-setup', '/flows?new=blank', '/quickstart']) {
    assert.ok(launcher.includes(route), `the launcher must still route to ${route}`);
  }
  // #2027 re-sorted the launcher into three tiers, so the page reads the tiers
  // rather than the flat list — but it is still a thin renderer over the pure
  // module, which is what this line is here to protect.
  assert.match(
    create, /heroEntry\(\)/,
    'Create.jsx stays a thin renderer over the pure module',
  );
  assert.match(create, /entriesByTier\(/);
});
